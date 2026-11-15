/**
 * Records real DeepSeek streams as test fixtures (packages/core/test/fixtures/models/deepseek-recorded-*.sse).
 * Needs DEEPSEEK_API_KEY. Only response bodies are saved, never request headers, so the key is not
 * written anywhere. Run: node --env-file=.env --import tsx scripts/record-deepseek-fixtures.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error('DEEPSEEK_API_KEY is not set');
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash';
const out = path.resolve(import.meta.dirname, '../packages/core/test/fixtures/models');

const calculator = {
  type: 'function',
  function: {
    name: 'calculator',
    description: 'Evaluate an arithmetic expression.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
  },
};

const recordings: { file: string; body: Record<string, unknown> }[] = [
  {
    file: 'deepseek-recorded-text.sse',
    body: { messages: [{ role: 'user', content: 'Greet me in exactly five words.' }] },
  },
  {
    file: 'deepseek-recorded-tool-call.sse',
    body: {
      messages: [
        { role: 'user', content: 'What is 48379 multiplied by 2917? Use the calculator.' },
      ],
      tools: [calculator],
    },
  },
];

for (const { file, body } of recordings) {
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 400,
      ...body,
    }),
  });
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status} ${await response.text()}`);
  const text = await response.text();
  const note = `: recorded from DeepSeek (${model}) on ${new Date().toISOString().slice(0, 10)} by scripts/record-deepseek-fixtures.ts`;
  fs.writeFileSync(path.join(out, file), `${note}\n\n${text}`, 'utf8');
  console.log(`${file}: ${text.length} bytes`);
}
