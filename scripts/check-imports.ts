/**
 * Import-direction check for packages/core/src (docs/02-target-architecture.md#layers).
 *
 * Each file belongs to the layer named by its first folder under src/. Entry files directly in src/
 * (cli.ts, index.ts) count as composition. A violation is an import of a layer the rules don't allow.
 *
 * Known violations from before the refactor are listed in import-baseline.json. The check fails on any
 * violation not in the baseline, and on any baseline entry that is no longer a violation (so the
 * baseline can only shrink). Run with --update-baseline only to remove fixed entries.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const LAYERS = [
  'domain',
  'ports',
  'application',
  'adapters',
  'interfaces',
  'plugins',
  'composition',
] as const;
export type Layer = (typeof LAYERS)[number];

export const RULES: Record<Layer, readonly Layer[]> = {
  domain: ['domain'],
  ports: ['ports', 'domain'],
  application: ['application', 'ports', 'domain'],
  adapters: ['adapters', 'ports', 'domain'],
  interfaces: ['interfaces', 'application', 'ports', 'domain'],
  plugins: ['plugins', 'adapters', 'ports', 'domain'],
  composition: [...LAYERS],
};

export interface SourceFile {
  /** Path relative to the src root, with forward slashes, e.g. "application/Agent.ts". */
  path: string;
  text: string;
}

export interface Problem {
  kind: 'violation' | 'unknown-layer' | 'unresolved';
  from: string;
  to?: string;
  message: string;
}

export function layerOf(srcPath: string): Layer | undefined {
  const first = srcPath.split('/')[0]!;
  if (!srcPath.includes('/')) return 'composition'; // entry files: src/cli.ts, src/index.ts
  return (LAYERS as readonly string[]).includes(first) ? (first as Layer) : undefined;
}

function resolve(from: string, spec: string, known: Set<string>): string | undefined {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const stem = joined.replace(/\.js$/, '');
  return [stem + '.ts', stem + '.tsx', stem + '/index.ts'].find((c) => known.has(c));
}

export function findProblems(files: SourceFile[]): Problem[] {
  const known = new Set(files.map((f) => f.path));
  const problems: Problem[] = [];
  for (const file of files) {
    const fromLayer = layerOf(file.path);
    if (!fromLayer) {
      problems.push({
        kind: 'unknown-layer',
        from: file.path,
        message: `${file.path} is not inside a layer folder (${LAYERS.join(', ')})`,
      });
      continue;
    }
    const { importedFiles } = ts.preProcessFile(file.text, true, true);
    for (const { fileName: spec } of importedFiles) {
      if (!spec.startsWith('.')) continue; // packages: vendor SDKs are checked by review, not here
      const target = resolve(file.path, spec, known);
      if (!target) {
        problems.push({
          kind: 'unresolved',
          from: file.path,
          to: spec,
          message: `${file.path} imports "${spec}", which is not a file in src`,
        });
        continue;
      }
      const toLayer = layerOf(target);
      if (toLayer && !RULES[fromLayer].includes(toLayer)) {
        problems.push({
          kind: 'violation',
          from: file.path,
          to: target,
          message: `${fromLayer} may not import ${toLayer}: ${file.path} -> ${target}`,
        });
      }
    }
  }
  return problems;
}

export const edgeKey = (p: Problem) => `${p.from} -> ${p.to}`;

export function compareWithBaseline(problems: Problem[], baseline: string[]) {
  const allowed = new Set(baseline);
  const current = new Set(problems.filter((p) => p.kind === 'violation').map(edgeKey));
  return {
    newProblems: problems.filter((p) => p.kind !== 'violation' || !allowed.has(edgeKey(p))),
    fixed: baseline.filter((edge) => !current.has(edge)),
  };
}

function readSources(srcRoot: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        const rel = path.relative(srcRoot, full).split(path.sep).join('/');
        out.push({ path: rel, text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(srcRoot);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function main() {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const srcRoot = path.resolve(here, '../packages/core/src');
  const baselineFile = path.join(here, 'import-baseline.json');
  const baseline: string[] = fs.existsSync(baselineFile)
    ? JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
    : [];

  const problems = findProblems(readSources(srcRoot));
  const { newProblems, fixed } = compareWithBaseline(problems, baseline);

  if (process.argv.includes('--update-baseline')) {
    if (newProblems.length) {
      console.error('Refusing to update the baseline while there are new problems:');
      for (const p of newProblems) console.error(`  ${p.message}`);
      process.exit(1);
    }
    const kept = baseline.filter((e) => !fixed.includes(e));
    fs.writeFileSync(baselineFile, JSON.stringify(kept, null, 2) + '\n');
    console.log(`Baseline updated: removed ${fixed.length}, ${kept.length} left.`);
    return;
  }

  for (const p of newProblems) console.error(`✗ ${p.message}`);
  for (const e of fixed) {
    console.error(`✗ Fixed but still in the baseline (run with --update-baseline): ${e}`);
  }
  if (newProblems.length || fixed.length) process.exit(1);
  console.log(`Import check passed (${baseline.length} known violations left in the baseline).`);
}

const invokedDirectly = process.argv[1] && /check-imports\.ts$/.test(process.argv[1]);
if (invokedDirectly) main();
