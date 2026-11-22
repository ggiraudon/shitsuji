import { parseArgs } from 'node:util';
import { formatReport, runEvals } from './harness.js';
import { scenarios } from './scenarios/index.js';

/**
 * `pnpm eval --model <provider/model>` runs every scenario against that model; `--offline` replays the
 * recorded fixtures instead (F22, S38). `--scenario <id>` runs one, `--json` prints the report as JSON.
 */
const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    offline: { type: 'boolean', default: false },
    scenario: { type: 'string' },
    json: { type: 'boolean', default: false },
    timeout: { type: 'string' },
  },
});

const list = values.scenario
  ? scenarios.filter((scenario) => scenario.id === values.scenario)
  : scenarios;
if (!list.length) {
  console.error(
    `No scenario "${values.scenario}". Known: ${scenarios.map((s) => s.id).join(', ')}`,
  );
  process.exit(2);
}
if (!values.offline && !values.model) {
  console.error('Use --model <provider/model>, or --offline to replay the recorded fixtures.');
  process.exit(2);
}

const report = await runEvals(
  {
    model: values.offline ? 'eval/offline' : values.model!,
    offline: values.offline,
    ...(values.timeout && { timeoutMs: Number(values.timeout) }),
  },
  list,
);

console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
process.exit(report.passRate === 1 ? 0 : 1);
