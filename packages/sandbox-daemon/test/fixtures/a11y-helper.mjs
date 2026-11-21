// A stand-in for the Python AT-SPI helper, so the sandboxd client's pipe, caps and restarts are
// testable without a desktop. It reads one JSON request per line and writes one reply per line.
import fs from 'node:fs';

const mode = process.env.A11Y_FIXTURE_MODE ?? 'normal';
const logFile = process.env.A11Y_FIXTURE_LOG;
const marker = process.env.A11Y_FIXTURE_MARKER;

const normal = mode !== 'hang-once' || (marker && fs.existsSync(marker));
if (mode === 'hang-once' && marker && !fs.existsSync(marker)) fs.writeFileSync(marker, '1');

const tree = (id) => ({
  id,
  ok: true,
  tree: {
    app: 'thunar',
    window: 's54-folder - File Manager',
    snapshot: 's1',
    nodes: [
      {
        ref: 'e1',
        depth: 0,
        role: 'frame',
        name: 's54-folder - File Manager',
        states: [],
        actions: [],
      },
      {
        ref: 'e2',
        depth: 1,
        role: 'push button',
        name: 'Open',
        states: ['disabled'],
        actions: ['click'],
      },
    ],
    total: 2,
    truncated: false,
  },
});

function reply(request) {
  const { id, op } = request;
  if (op === 'ping') return { id, ok: true, version: 1 };
  if (op === 'apps') {
    return {
      id,
      ok: true,
      apps: [
        { name: 'thunar', frames: 1, nodes: 4 },
        { name: 'Chromium', frames: 1, nodes: 9 },
      ],
    };
  }
  if (op === 'tree' || op === 'find') return tree(id);
  if (op === 'act') {
    if (request.ref === 'e999') {
      return { id, error: { code: 'stale', message: 'stale, take a new snapshot' } };
    }
    return {
      id,
      ok: true,
      result: {
        ok: true,
        action: request.action,
        role: 'push button',
        name: 'Open',
        window: 's54-folder - File Manager',
        app: 'thunar',
      },
    };
  }
  return { id, error: { code: 'invalid', message: 'Unknown operation.' } };
}

function handle(line) {
  const request = JSON.parse(line);
  if (logFile) fs.appendFileSync(logFile, `${request.op}\n`);
  if (mode === 'hang' && request.op !== 'ping') return;
  if (mode === 'hang-once' && !normal && request.op !== 'ping') return;
  if (mode === 'die' && request.op !== 'ping') process.exit(3);
  if (mode === 'garbage' && request.op !== 'ping') {
    process.stdout.write('not json\n');
    return;
  }
  if (mode === 'huge' && request.op !== 'ping') {
    process.stdout.write('x'.repeat(3 * 1024 * 1024));
    return;
  }
  process.stdout.write(`${JSON.stringify(reply(request))}\n`);
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (line.trim()) handle(line);
  }
});
// A hanging mode keeps the event loop alive so the parent's deadline is the one that ends it.
setInterval(() => {}, 1_000);
