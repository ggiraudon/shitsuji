import { describe, expect, it, vi } from 'vitest';
import { MemoryLogger } from '../../src/adapters/logging/loggers.js';
import { asId, type OwnerId } from '../../src/domain/model/ids.js';
import { createApi, type ApiDeps } from '../../src/interfaces/http/createApi.js';
import { VIEWER_COOKIE } from '../../src/interfaces/http/desktopViewer.js';

const OWNER = asId<OwnerId>('owner');
const KEY = 'owner-key';
const PASSWORD = 'view-only-pass';

function setup(options: { ttlMs?: number; clientAddress?: () => string } = {}) {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = { now: () => new Date(now) };
  const credentials = vi.fn(async () => ({ viewOnlyPassword: PASSWORD }));
  const log = new MemoryLogger();
  const app = createApi({
    agent: {},
    repos: {},
    events: {},
    clock,
    log,
    ownerId: OWNER,
    soul: {},
    pairing: {},
    approvals: {},
    verifyKey: (key: string | undefined) => key === KEY,
    viewer: {
      credentials,
      stream: { host: '127.0.0.1', port: 1 },
      cookieSecure: false,
      ...(options.ttlMs !== undefined && { cookieTtlMs: options.ttlMs }),
      ...(options.clientAddress && { clientAddress: options.clientAddress }),
    },
  } as unknown as ApiDeps);
  return {
    app,
    credentials,
    log,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function signIn(app: ReturnType<typeof setup>['app']): Promise<string> {
  const response = await app.request('/desktop/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `key=${KEY}`,
  });
  expect(response.status).toBe(303);
  const cookie = response.headers.getSetCookie()[0];
  expect(cookie).toBeDefined();
  return cookie!.split(';')[0]!;
}

describe('desktop viewer page and cookie (S51)', () => {
  it('refuses /desktop and its credentials until the owner signs in', async () => {
    const { app, credentials } = setup();
    expect((await app.request('/desktop')).status).toBe(401);
    expect((await app.request('/desktop/credentials')).status).toBe(401);
    expect(credentials).not.toHaveBeenCalled();

    const login = await app.request('/desktop/login');
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('action="/desktop/login"');

    const wrong = await app.request('/desktop/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'key=wrong',
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
  });

  it('exchanges the key for an HttpOnly SameSite=Strict cookie, never in a URL', async () => {
    const { app } = setup();
    const response = await app.request('/desktop/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `key=${KEY}`,
    });
    const cookie = response.headers.getSetCookie()[0]!;
    expect(cookie).toContain(`${VIEWER_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/desktop');
    expect(cookie).not.toContain(KEY);

    const page = await app.request('/desktop', { headers: { cookie: cookie.split(';')[0]! } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('/desktop/viewer.js');
    expect(html).not.toContain(PASSWORD);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
  });

  it('serves the password only after the cookie check', async () => {
    const { app, credentials } = setup();
    const cookie = await signIn(app);

    const denied = await app.request('/desktop/credentials');
    expect(denied.status).toBe(401);
    expect(credentials).not.toHaveBeenCalled();

    const allowed = await app.request('/desktop/credentials', {
      headers: { cookie },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ viewOnlyPassword: PASSWORD });
    expect(credentials).toHaveBeenCalledTimes(1);
  });

  it('refuses an expired cookie and clears it on logout', async () => {
    const { app, advance } = setup({ ttlMs: 1_000 });
    const cookie = await signIn(app);
    advance(1_001);
    expect((await app.request('/desktop', { headers: { cookie } })).status).toBe(401);

    const fresh = await signIn(app);
    const logout = await app.request('/desktop/logout', {
      method: 'POST',
      headers: { cookie: fresh },
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get('set-cookie')).toContain(`${VIEWER_COOKIE}=`);
    expect((await app.request('/desktop', { headers: { cookie: fresh } })).status).toBe(401);
  });

  it('refuses cross-origin login and logout (S51)', async () => {
    const { app } = setup();
    const badLogin = await app.request('/desktop/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://evil.example',
      },
      body: `key=${KEY}`,
    });
    expect(badLogin.status).toBe(403);

    const goodLogin = await app.request('/desktop/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://localhost',
      },
      body: `key=${KEY}`,
    });
    expect(goodLogin.status).toBe(303);
    const cookie = goodLogin.headers.getSetCookie()[0]!.split(';')[0]!;

    const badLogout = await app.request('/desktop/logout', {
      method: 'POST',
      headers: { cookie, origin: 'http://evil.example' },
    });
    expect(badLogout.status).toBe(403);
    expect((await app.request('/desktop', { headers: { cookie } })).status).toBe(200);

    const goodLogout = await app.request('/desktop/logout', {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost' },
    });
    expect(goodLogout.status).toBe(303);
  });

  it('throttles wrong keys after five attempts in a five-minute window (S51)', async () => {
    const { app, log, advance } = setup({ clientAddress: () => '203.0.113.9' });
    const wrong = () =>
      app.request('/desktop/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'key=wrong',
      });

    for (let i = 0; i < 5; i++) expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(429);
    expect((await wrong()).status).toBe(429);
    expect(
      log.records.filter((record) => record.message === 'Viewer sign-in throttled'),
    ).toHaveLength(1);

    advance(5 * 60 * 1000 + 1);
    expect((await wrong()).status).toBe(401);
  });

  it('serves the pinned noVNC client and refuses paths outside it', async () => {
    const { app } = setup();
    const rfb = await app.request('/desktop/vendor/novnc/core/rfb.js');
    expect(rfb.status).toBe(200);
    expect(rfb.headers.get('content-type')).toContain('text/javascript');
    expect(await rfb.text()).toContain('import');

    expect((await app.request('/desktop/vendor/novnc/core/../../package.json')).status).toBe(404);
    expect((await app.request('/desktop/vendor/novnc/core/display.json')).status).toBe(404);
    expect((await app.request('/desktop/vendor/novnc/docs/API.md')).status).toBe(404);
  });

  it('loads the viewer script without the password in it', async () => {
    const { app } = setup();
    const script = await app.request('/desktop/viewer.js');
    expect(script.status).toBe(200);
    const body = await script.text();
    expect(body).toContain("'/desktop/vendor/novnc/core/rfb.js'");
    expect(body).toContain("'/desktop/credentials'");
    expect(body).toContain('/desktop/stream');
    expect(body).not.toContain(PASSWORD);
  });
});
