/**
 * Reads a Server-Sent Events body and yields each event's data (multi-line data joined with "\n").
 * Comments (": keep-alive") and other fields are ignored.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer[newline] === '\r' ? 2 : 1));
        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
        if (data.length) yield data.join('\n');
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
