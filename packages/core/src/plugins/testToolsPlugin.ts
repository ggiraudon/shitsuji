import { NotifyTool } from '../adapters/tools/NotifyTool.js';
import type { PluginRegistrationContext, ShitsujiPlugin } from '../ports/Plugin.js';

export interface TestToolsPluginOptions {
  /** The local mock service `test.notify` posts to. */
  notifyUrl: string;
  /** A stand-in for fetch in tests; composition uses the global one. */
  fetch?: typeof fetch;
}

/**
 * The test tools (F11, S36). `test.notify` acts outside the workspace on purpose: it is the cheapest
 * way to exercise trust, the judge and an approval card without a real email or shop (S38).
 */
export class TestToolsPlugin implements ShitsujiPlugin {
  readonly manifest = {
    id: 'builtin.test-tools',
    name: 'Test tools',
    version: '0.1.0',
    provides: ['tools'],
  } as const;

  constructor(private readonly options: TestToolsPluginOptions) {}

  register(ctx: PluginRegistrationContext): void {
    ctx.addTools([
      new NotifyTool({
        url: this.options.notifyUrl,
        ...(this.options.fetch && { fetch: this.options.fetch }),
      }),
    ]);
  }
}
