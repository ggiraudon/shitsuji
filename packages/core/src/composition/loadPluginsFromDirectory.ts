import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { PluginError } from '../application/PluginManager.js';
import type { Logger } from '../ports/Logger.js';
import type { ShitsujiPlugin } from '../ports/Plugin.js';

const manifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1),
  version: z.string().min(1),
  provides: z.array(z.enum(['model', 'channel', 'tools', 'context'])),
  description: z.string().optional(),
});

/**
 * Loads plugins the owner put in plugins.directory: each `*.js` / `*.mjs` file, or each folder with an
 * `index.js`, whose default export is a plugin or a function returning one. This runs code with the
 * core's permissions, so only the owner's own configured folder is ever read.
 */
export async function loadPluginsFromDirectory(
  dir: string,
  log: Logger,
): Promise<ShitsujiPlugin[]> {
  if (!fs.existsSync(dir)) {
    log.warn('Plugin directory does not exist; no external plugins loaded', { dir });
    return [];
  }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const plugins: ShitsujiPlugin[] = [];
  for (const entry of entries) {
    const file = entry.isDirectory()
      ? path.join(dir, entry.name, 'index.js')
      : /\.m?js$/.test(entry.name)
        ? path.join(dir, entry.name)
        : undefined;
    if (!file || !fs.existsSync(file)) continue;
    plugins.push(await importPlugin(file));
  }
  return plugins;
}

async function importPlugin(file: string): Promise<ShitsujiPlugin> {
  let mod: { default?: unknown };
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (error) {
    throw new PluginError(file, `cannot be imported: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const exported = typeof mod.default === 'function' ? await mod.default() : mod.default;
  const plugin = exported as Partial<ShitsujiPlugin> | undefined;
  if (!plugin || typeof plugin.register !== 'function') {
    throw new PluginError(
      file,
      'must default-export a plugin object (or a function returning one)',
    );
  }
  const manifest = manifestSchema.safeParse(plugin.manifest);
  if (!manifest.success) {
    throw new PluginError(
      file,
      `has an invalid manifest: ${manifest.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }
  return plugin as ShitsujiPlugin;
}
