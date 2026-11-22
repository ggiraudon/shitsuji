import type { Tool, ToolContext, ToolOutput } from '../../../ports/Tool.js';

/**
 * Marks a tool's output as untrusted (F08, #141). A driver's extra tools are third-party code that
 * runs against the sandbox, so core wraps them at registration: the pipeline's untrusted-wrap step
 * then puts their result in `<untrusted_data>` with the "data, not instructions" line, exactly as it
 * does for `web.fetch`. Core's own tools are not wrapped here; each one decides for itself whether it
 * returns file or command content (`workspace.read`, `workspace.exec`, …) or only a status.
 */
export function asUntrustedTool(tool: Tool): Tool {
  return new UntrustedTool(tool);
}

/** Delegates to the wrapped tool, with `untrustedOutput` forced on. */
class UntrustedTool implements Tool {
  /** Always true: this wrapper exists to force the pipeline's wrap step. */
  readonly untrustedOutput = true;

  constructor(private readonly inner: Tool) {}

  /** The wrapped tool's name, unchanged. */
  get name(): string {
    return this.inner.name;
  }

  /** The wrapped tool's description, unchanged. */
  get description(): string {
    return this.inner.description;
  }

  /** The wrapped tool's argument schema, unchanged. */
  get input(): Tool['input'] {
    return this.inner.input;
  }

  /** The wrapped tool's effect (a value or an argument-dependent function), unchanged. */
  get effect(): Tool['effect'] {
    return this.inner.effect;
  }

  /** The wrapped tool's target, unchanged. */
  get target(): Tool['target'] {
    return this.inner.target;
  }

  /** The wrapped tool's deferred flag, unchanged. */
  get deferred(): boolean {
    return this.inner.deferred;
  }

  /** Runs the wrapped tool; its output is wrapped by the pipeline on the way back. */
  run(args: unknown, ctx: ToolContext): Promise<ToolOutput> {
    return this.inner.run(args, ctx);
  }
}
