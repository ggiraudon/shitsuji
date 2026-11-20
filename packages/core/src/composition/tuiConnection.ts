import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../domain/errors.js';
import { ApiClient } from '../interfaces/tui/ApiClient.js';
import type { ShitsujiConfig } from './config/schema.js';
import { publicUrlOf } from './config/publicUrl.js';

/**
 * Finds core for the TUI: tui.apiUrl (SHITSUJI_API_URL) or this machine's API port, and the owner key
 * from tui.ownerKey (SHITSUJI_OWNER_KEY) or <dataDir>/owner.key. Fails with what to do next.
 */
export async function connectTui(config: ShitsujiConfig): Promise<ApiClient> {
  const port = config.api.publishedPort ?? config.api.port;
  const url = config.tui.apiUrl ?? `http://127.0.0.1:${port}`;
  const keyFile = path.join(config.paths.dataDir, 'owner.key');
  const key =
    config.tui.ownerKey?.reveal() ??
    (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : undefined);
  if (!key) {
    throw new ConfigError(
      `No owner key. Start core once (it creates ${keyFile}), or, if core runs in Docker, copy the ` +
        'key it printed at first start ("docker compose logs core | grep owner key") into ' +
        'SHITSUJI_OWNER_KEY in .env.',
    );
  }
  const client = new ApiClient(url, key, fetch, publicUrlOf(config));
  if (!(await client.health())) {
    throw new ConfigError(
      `Shitsuji is not answering at ${url}. Start it first ("node packages/core/dist/cli.js" or ` +
        '"docker compose up -d"), or set SHITSUJI_API_URL.',
    );
  }
  return client;
}
