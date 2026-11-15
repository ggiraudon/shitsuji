import { describe, expect, it } from 'vitest';
import { compareWithBaseline, findProblems, layerOf, type SourceFile } from './check-imports.js';

const file = (path: string, ...imports: string[]): SourceFile => ({
  path,
  text: imports.map((spec, i) => `import { x${i} } from '${spec}';`).join('\n'),
});

describe('layerOf', () => {
  it('uses the first folder, and treats top-level entry files as composition', () => {
    expect(layerOf('application/Agent.ts')).toBe('application');
    expect(layerOf('adapters/models/OpenAIProvider.ts')).toBe('adapters');
    expect(layerOf('cli.ts')).toBe('composition');
    expect(layerOf('utils/logger.ts')).toBeUndefined();
  });
});

describe('findProblems', () => {
  it('allows imports the rules permit', () => {
    const files = [
      file('domain/Turn.ts'),
      file('ports/ModelProvider.ts', '../domain/Turn.js'),
      file('application/TurnRunner.ts', '../ports/ModelProvider.js', '../domain/Turn.js'),
      file('adapters/models/OpenAI.ts', '../../ports/ModelProvider.js', 'openai'),
      file('composition/createShitsuji.ts', '../adapters/models/OpenAI.js'),
    ];
    expect(findProblems(files)).toEqual([]);
  });

  it('fails when application imports an adapter', () => {
    const files = [
      file('adapters/storage/Store.ts'),
      file('application/Agent.ts', '../adapters/storage/Store.js'),
    ];
    expect(findProblems(files)).toEqual([
      expect.objectContaining({
        kind: 'violation',
        from: 'application/Agent.ts',
        to: 'adapters/storage/Store.ts',
      }),
    ]);
  });

  it('fails when domain imports ports, and catches dynamic imports', () => {
    const files: SourceFile[] = [
      file('ports/Clock.ts'),
      { path: 'domain/Turn.ts', text: `const m = await import('../ports/Clock.js');` },
    ];
    expect(findProblems(files).map((p) => p.kind)).toEqual(['violation']);
  });

  it('reports files outside any layer and imports that do not resolve', () => {
    const files = [file('utils/x.ts'), file('domain/Turn.ts', './Missing.js')];
    expect(
      findProblems(files)
        .map((p) => p.kind)
        .sort(),
    ).toEqual(['unknown-layer', 'unresolved']);
  });
});

describe('compareWithBaseline', () => {
  const files = [file('adapters/A.ts'), file('application/B.ts', '../adapters/A.js')];

  it('accepts violations listed in the baseline', () => {
    const result = compareWithBaseline(findProblems(files), ['application/B.ts -> adapters/A.ts']);
    expect(result).toEqual({ newProblems: [], fixed: [] });
  });

  it('flags baseline entries that are no longer violations, so the baseline only shrinks', () => {
    const result = compareWithBaseline(findProblems([file('adapters/A.ts')]), [
      'application/B.ts -> adapters/A.ts',
    ]);
    expect(result.fixed).toEqual(['application/B.ts -> adapters/A.ts']);
  });
});
