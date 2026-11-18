import { NotifyTool } from '../packages/core/src/adapters/tools/NotifyTool.js';
import { TestMailTool } from '../packages/core/src/adapters/tools/TestMailTool.js';
import { WebFetchTool } from '../packages/core/src/adapters/tools/web.js';
import type { ModelProvider } from '../packages/core/src/ports/ModelProvider.js';
import type {
  PluginRegistrationContext,
  ShitsujiPlugin,
} from '../packages/core/src/ports/Plugin.js';
import { MAILBOX_URL, NOTIFY_URL, type MockServices } from './fakes.js';

/**
 * The tools the harness needs, wired to the in-process mock world (S38): `test.notify` and `test.mail`
 * are external, and `web.fetch` reads the fixture pages without a socket.
 */
export class EvalToolsPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'eval.tools',
    name: 'Evaluation tools',
    version: '1',
    provides: ['tools'],
  } as const;

  constructor(private readonly services: MockServices) {}

  register(ctx: PluginRegistrationContext): void {
    ctx.addTools([
      new NotifyTool({ url: NOTIFY_URL, fetch: this.services.toolsFetch }),
      new TestMailTool({ url: MAILBOX_URL, fetch: this.services.toolsFetch }),
      new WebFetchTool({ fetch: this.services.pageFetch, resolver: this.services.resolve }),
    ]);
  }
}

/** Registers the offline model under `eval`, so purposes can point at `eval/offline`. */
export class EvalModelPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'eval.model',
    name: 'Evaluation model',
    version: '1',
    provides: ['model'],
  } as const;

  constructor(private readonly provider: ModelProvider) {}

  register(ctx: PluginRegistrationContext): void {
    ctx.addModelProvider(this.provider);
  }
}
