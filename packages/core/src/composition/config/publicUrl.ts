import type { ShitsujiConfig } from './schema.js';

const WILDCARD = new Set(['0.0.0.0', '::', '[::]', '*']);

/**
 * The base URL for links core sends (the `/desktop` command), not for its own connections (Y2).
 * `api.publicUrl` wins; otherwise this is the published address and port, or loopback when the
 * published address is a wildcard. It follows the TLS setting because the scheme must match it.
 */
export function publicUrlOf(config: ShitsujiConfig): string {
  if (config.api.publicUrl) return config.api.publicUrl.replace(/\/+$/, '');
  const scheme = config.api.tls ? 'https' : 'http';
  const published = config.api.publishedHost?.trim();
  const host = published && !WILDCARD.has(published) ? published : '127.0.0.1';
  const port = config.api.publishedPort ?? config.api.port;
  return `${scheme}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}
