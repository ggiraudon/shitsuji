import type { ToolSpec } from '../../ports/ModelProvider.js';

/**
 * OpenAI-style and Anthropic APIs accept tool names matching ^[a-zA-Z0-9_-]{1,64}$, so dotted internal
 * names ("workspace.exec") go over the wire as "workspace__exec" and come back mapped by lookup.
 */
export class ToolNameMap {
  private readonly fromWire = new Map<string, string>();

  constructor(tools: readonly ToolSpec[] = []) {
    for (const t of tools) this.fromWire.set(ToolNameMap.toWire(t.name), t.name);
  }

  static toWire(name: string): string {
    return name.replace(/\./g, '__');
  }

  /** The internal name for a name the model sent; unknown names pass through unchanged. */
  internal(wire: string): string {
    return this.fromWire.get(wire) ?? wire;
  }
}
