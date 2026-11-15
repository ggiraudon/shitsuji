import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'models');

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** A fixture file name in test/fixtures/models, or a literal body. */
  fixture?: string;
  body?: string;
}

/**
 * A fetch that replays fixtures and records what was sent. The body is delivered in small chunks so
 * SSE lines and multi-byte characters are split across reads, as on a real network.
 */
export function fixtureFetch(...replies: FakeReply[]) {
  const requests: RecordedRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const reply = replies.shift();
    if (!reply) throw new Error('fixtureFetch: no reply left');
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const text = reply.fixture
      ? fs.readFileSync(path.join(dir, reply.fixture), 'utf8')
      : (reply.body ?? '');
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    return new Response(body, { status: reply.status ?? 200, headers: reply.headers });
  };
  return { fetch: impl as typeof fetch, requests };
}
