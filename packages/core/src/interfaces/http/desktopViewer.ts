import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { UpgradeWebSocket } from 'hono/ws';
import WebSocket from 'ws';
import type { OwnerId } from '../../domain/model/ids.js';
import type { Clock } from '../../ports/Clock.js';
import type { Logger } from '../../ports/Logger.js';
import type { ViewerCredentials } from '../../ports/SandboxDriver.js';

/** The cookie the viewer page uses; HttpOnly and SameSite=Strict, never the owner key itself. */
export const VIEWER_COOKIE = 'shitsuji_viewer';
/** How long a viewer sign-in lasts, in milliseconds: one hour. */
export const VIEWER_COOKIE_TTL_MS = 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

/** Where the gateway's view-only WebSocket listens, as core reaches it on the internal network. */
export interface ViewerStream {
  /** The gateway's view-only stream listener; core reaches it on the internal network. */
  host: string;
  /** The gateway's stream port; the viewer relays raw WebSocket frames to it. */
  port: number;
}

/** What the viewer needs from the rest of core: auth, the clock, sandboxd's password, the relay. */
export interface ViewerDeps {
  /** The same owner-key check the API uses. */
  verifyKey: (key: string | undefined) => boolean;
  /** The owner the session cookie belongs to; one per install. */
  ownerId: OwnerId;
  /** Injected clock: sign-in expiry and the login throttle use it. */
  clock: Clock;
  /** Structured logger for rejected sign-ins and relay failures. */
  log: Logger;
  /** Reads the view-only password from sandboxd (token-protected). */
  credentials: () => Promise<ViewerCredentials>;
  /** The gateway's view-only stream, relayed to the browser once the cookie is valid. */
  stream: ViewerStream;
  /** True when the API is served over TLS, so the cookie carries Secure. */
  cookieSecure: boolean;
  /** Tests shorten the lifetime; production keeps one hour. */
  cookieTtlMs?: number;
  /** The client address used for login throttling; defaults to the socket's peer address. */
  clientAddress?: (c: Context) => string;
  /** Built by `@hono/node-ws`; omitted in REST-only unit tests. */
  upgradeWebSocket?: UpgradeWebSocket;
}

interface ViewerSession {
  ownerId: OwnerId;
  expiresAt: number;
}

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; " +
    "img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  // `same-origin`, not `no-referrer`: with `no-referrer` browsers send `Origin: null` on the login
  // form, which the Origin check refuses. Other sites still get no referrer.
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
} as const;

/**
 * The desktop viewer (S51): the page, its bundled noVNC client, the owner-key exchange and the
 * cookie-gated WebSocket relay to the gateway's view-only stream. Core never joins the sandbox
 * network; the relay is a plain TCP client of the gateway.
 */
export function registerViewer(app: Hono, deps: ViewerDeps): void {
  const sessions = new Map<string, ViewerSession>();
  const failures = new Map<string, { count: number; windowStart: number; warned: boolean }>();
  const ttlMs = deps.cookieTtlMs ?? VIEWER_COOKIE_TTL_MS;
  const vendorRoot = novncRoot();
  const addressOf =
    deps.clientAddress ??
    ((c: Context) => {
      const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
        ?.incoming;
      return incoming?.socket?.remoteAddress ?? 'unknown';
    });
  const sameOrigin = (c: Context): boolean => {
    const origin = c.req.header('origin');
    if (!origin) return true;
    // @hono/node-ws builds its upgrade URL against http://localhost, so the Host header is the
    // only reliable own-origin for the stream; the socket tells us whether it is TLS.
    const incoming = (c.env as { incoming?: { socket?: { encrypted?: boolean } } } | undefined)
      ?.incoming;
    const url = new URL(c.req.url);
    const host = c.req.header('host') ?? url.host;
    const scheme = incoming?.socket?.encrypted ? 'https' : url.protocol.replace(':', '');
    return origin === `${scheme}://${host}`;
  };

  const sessionOf = (c: Context): ViewerSession | undefined => {
    const token = getCookie(c, VIEWER_COOKIE);
    if (!token) return undefined;
    const session = sessions.get(token);
    if (!session) return undefined;
    if (session.ownerId !== deps.ownerId || session.expiresAt <= deps.clock.now().getTime()) {
      sessions.delete(token);
      return undefined;
    }
    return session;
  };

  const requireSession = (c: Context) => {
    if (sessionOf(c)) return undefined;
    return c.html(unauthorizedPage(), 401, SECURITY_HEADERS);
  };

  app.get('/desktop/login', (c) => {
    if (sessionOf(c)) return c.redirect('/desktop', 303);
    return c.html(loginPage(), 200, SECURITY_HEADERS);
  });

  app.post('/desktop/login', async (c) => {
    if (!sameOrigin(c)) return c.text('Cross-origin request refused.', 403);
    const now = deps.clock.now().getTime();
    const address = addressOf(c);
    for (const [key, entry] of failures) {
      if (now - entry.windowStart >= LOGIN_WINDOW_MS) failures.delete(key);
    }
    const failed = failures.get(address);
    if (failed && failed.count >= LOGIN_MAX_FAILURES) {
      if (!failed.warned) {
        failed.warned = true;
        deps.log.warn('Viewer sign-in throttled', { address });
      }
      const retryAfter = Math.max(
        1,
        Math.ceil((LOGIN_WINDOW_MS - (now - failed.windowStart)) / 1000),
      );
      return c.text('Too many attempts. Try again later.', 429, {
        'retry-after': String(retryAfter),
      });
    }
    const body = await c.req.parseBody().catch(() => undefined);
    const key = typeof body?.key === 'string' ? body.key : undefined;
    if (!deps.verifyKey(key)) {
      const next = failed ?? { count: 0, windowStart: now, warned: false };
      next.count += 1;
      failures.set(address, next);
      deps.log.warn('Viewer sign-in refused', { address });
      return c.html(loginPage('That key is not right.'), 401, SECURITY_HEADERS);
    }
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { ownerId: deps.ownerId, expiresAt: now + ttlMs });
    setCookie(c, VIEWER_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Strict',
      path: '/desktop',
      secure: deps.cookieSecure,
      maxAge: Math.floor(ttlMs / 1000),
    });
    return c.redirect('/desktop', 303);
  });

  app.post('/desktop/logout', (c) => {
    if (!sameOrigin(c)) return c.text('Cross-origin request refused.', 403);
    const token = getCookie(c, VIEWER_COOKIE);
    if (token) sessions.delete(token);
    deleteCookie(c, VIEWER_COOKIE, { path: '/desktop' });
    return c.redirect('/desktop/login', 303);
  });

  app.get('/desktop', (c) => {
    const denied = requireSession(c);
    if (denied) return denied;
    return c.html(viewerPage(), 200, SECURITY_HEADERS);
  });

  app.get('/desktop/credentials', async (c) => {
    const denied = requireSession(c);
    if (denied) return denied;
    try {
      const credentials = await deps.credentials();
      return c.json({ viewOnlyPassword: credentials.viewOnlyPassword }, 200, {
        'cache-control': 'no-store',
      });
    } catch (error) {
      deps.log.warn('Viewer credentials are not available', {
        error: { message: error instanceof Error ? error.message : 'unknown' },
      });
      return c.json({ error: 'The desktop credentials are not available.' }, 503, {
        'cache-control': 'no-store',
      });
    }
  });

  app.get('/desktop/viewer.js', (c) =>
    c.body(VIEWER_JS, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    }),
  );

  app.get('/desktop/vendor/novnc/*', async (c) => {
    const relative = safeVendorPath(c.req.path);
    if (!relative) return c.notFound();
    try {
      const body = await readFile(resolve(vendorRoot, relative), 'utf8');
      return c.body(body, 200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      });
    } catch {
      return c.notFound();
    }
  });

  if (deps.upgradeWebSocket) {
    app.get(
      '/desktop/stream',
      async (c, next) => {
        if (!sameOrigin(c)) return c.json({ error: 'Cross-origin request refused.' }, 403);
        const denied = requireSession(c);
        if (denied) return denied;
        return next();
      },
      deps.upgradeWebSocket(() => {
        let upstream: WebSocket | undefined;
        return {
          onOpen(_event, ws) {
            const socket = new WebSocket(`ws://${deps.stream.host}:${deps.stream.port}/`, {
              perMessageDeflate: false,
            });
            upstream = socket;
            socket.on('message', (data) => {
              if (ws.readyState === 1) ws.send(new Uint8Array(data as Buffer));
            });
            socket.on('error', () => ws.close(1011, 'viewer stream unavailable'));
            socket.on('close', () => ws.close(1000, 'viewer stream closed'));
          },
          onMessage(event) {
            if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
            const data = event.data;
            if (typeof data === 'string') {
              upstream.send(data);
            } else if (data instanceof ArrayBuffer) {
              upstream.send(new Uint8Array(data), { binary: true });
            } else if (ArrayBuffer.isView(data)) {
              upstream.send(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
                binary: true,
              });
            } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
              void data.arrayBuffer().then((buffer) => {
                if (upstream?.readyState === WebSocket.OPEN) {
                  upstream.send(new Uint8Array(buffer), { binary: true });
                }
              });
            }
          },
          onClose() {
            upstream?.close();
            upstream = undefined;
          },
          onError() {
            upstream?.terminate();
            upstream = undefined;
          },
        };
      }),
    );
  }
}

/** Only the two JS trees of the pinned package are served, and only `.js` files. */
function safeVendorPath(path: string): string | undefined {
  const prefix = '/desktop/vendor/novnc/';
  if (!path.startsWith(prefix)) return undefined;
  let relative: string;
  try {
    relative = decodeURIComponent(path.slice(prefix.length));
  } catch {
    return undefined;
  }
  if (!relative || relative.includes('\0') || !relative.endsWith('.js')) return undefined;
  if (!/^(core|vendor)\//.test(relative)) return undefined;
  if (relative.split('/').some((segment) => segment === '..')) return undefined;
  return relative;
}

/** The package root of the pinned `@novnc/novnc`; it ships `core/` and `vendor/`. */
function novncRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(dirname(require.resolve('@novnc/novnc')));
}

function unauthorizedPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shitsuji desktop</title></head>
<body><p>Sign in to watch the desktop: <a href="/desktop/login">/desktop/login</a>.</p></body></html>`;
}

function loginPage(error?: string): string {
  const message = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shitsuji desktop — sign in</title>
<style>
  :root { color-scheme: dark; }
  body { font: 16px/1.5 system-ui, sans-serif; background: #111; color: #eee; display: grid;
    place-items: center; min-height: 100vh; margin: 0; }
  form { background: #1c1c1c; padding: 2rem; border-radius: .75rem; width: min(90vw, 24rem); }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  label { display: block; margin-bottom: .35rem; }
  input { width: 100%; box-sizing: border-box; padding: .6rem; border-radius: .4rem;
    border: 1px solid #444; background: #0b0b0b; color: inherit; }
  button { margin-top: 1rem; width: 100%; padding: .65rem; border: 0; border-radius: .4rem;
    background: #3b82f6; color: white; font-weight: 600; cursor: pointer; }
  .error { color: #fca5a5; }
  p { margin: .75rem 0 0; }
</style>
</head>
<body>
<form method="post" action="/desktop/login">
  <h1>Watch the Shitsuji desktop</h1>
  ${message}
  <label for="key">Owner key</label>
  <input id="key" name="key" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}

function viewerPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shitsuji desktop</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; background: #111; color: #eee;
    font: 14px/1.4 system-ui, sans-serif; }
  body { display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 1rem; padding: .5rem .75rem;
    border-bottom: 1px solid #333; }
  header span { flex: 1; }
  button { border: 1px solid #444; border-radius: .35rem; background: #1c1c1c;
    color: inherit; padding: .35rem .7rem; cursor: pointer; }
  #screen { flex: 1; min-height: 0; background: #000; }
  #screen > div { width: 100%; height: 100%; }
  #status { margin: 0; padding: .35rem .75rem; color: #9ca3af; border-top: 1px solid #333; }
</style>
</head>
<body>
<header><span>Shitsuji desktop — watch-only</span>
  <form method="post" action="/desktop/logout"><button type="submit">Sign out</button></form>
</header>
<div id="screen"></div>
<p id="status">Loading the viewer…</p>
<script type="module" src="/desktop/viewer.js"></script>
</body>
</html>`;
}

const VIEWER_JS = `import RFB from '/desktop/vendor/novnc/core/rfb.js';

const status = document.getElementById('status');
const screen = document.getElementById('screen');

async function start() {
  const response = await fetch('/desktop/credentials', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (response.status === 401) {
    location.href = '/desktop/login';
    return;
  }
  if (!response.ok) {
    status.textContent = 'The desktop is not available yet.';
    return;
  }
  const { viewOnlyPassword } = await response.json();
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const rfb = new RFB(screen, scheme + '://' + location.host + '/desktop/stream', {
    credentials: { password: viewOnlyPassword },
    shared: true,
  });
  rfb.viewOnly = true;
  rfb.scaleViewport = true;
  rfb.addEventListener('connect', () => {
    status.textContent = 'Connected — watch-only';
  });
  rfb.addEventListener('disconnect', (event) => {
    status.textContent = event.detail.clean ? 'Disconnected.' : 'The connection was lost.';
  });
  rfb.addEventListener('securityfailure', () => {
    status.textContent = 'The desktop refused the viewer password.';
  });
}

start().catch((error) => {
  status.textContent = 'Cannot load the viewer: ' + error.message;
});
`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : ch === '"'
            ? '&quot;'
            : '&#39;',
  );
}
