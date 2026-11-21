import type {
  DesktopA11yFindQuery,
  DesktopA11yTree,
  DesktopA11yTreeNode,
} from '../../ports/SandboxDriver.js';

/**
 * The compact tree format from F10 (S54): indented text with one `[eN]` ref per actionable node,
 * leaf siblings on one line, and a cap of about 8,000 tokens per window. The output is untrusted
 * text: every name and value comes from an application, so the tool marks it as such.
 */
export const A11Y_TREE_MAX_CHARS = 32_000;

/** Room for the closing note, so a full tree still says how to ask for a sub-tree. */
const NOTE_RESERVE = 500;

/** The roles whose node is the window itself; the header already names the window. */
const WINDOW_ROLES = new Set(['frame', 'dialog', 'window']);

const SHOWN_STATES = new Set(['disabled', 'checked', 'focused', 'selected', 'expanded']);

/**
 * Formats a window's tree. The frame node is folded into the header; a sub-tree request formats the
 * requested element as the first line. When the tree is cut, the note names the window and a ref to
 * continue from.
 */
export function formatA11yTree(tree: DesktopA11yTree): string {
  const header = `window "${escape(tree.window)}" (${tree.app}) — snapshot ${tree.snapshot}`;
  const nodes = tree.nodes;
  const foldRoot =
    nodes[0] !== undefined &&
    nodes[0].depth === 0 &&
    WINDOW_ROLES.has(nodes[0].role) &&
    nodes[0].name === tree.window;
  const start = foldRoot ? 1 : 0;
  const lines: string[] = [];
  let used = header.length + 1;
  let last: { depth: number; leaf: boolean; index: number } | undefined;
  let cut = false;
  const bodyBudget = A11Y_TREE_MAX_CHARS - NOTE_RESERVE;

  for (let index = start; index < nodes.length; index++) {
    const node = nodes[index]!;
    const next = nodes[index + 1];
    const depth = foldRoot ? node.depth - 1 : node.depth;
    const leaf = next === undefined || next.depth <= node.depth;
    const text = nodeLine(node);
    if (leaf && last?.leaf && last.depth === depth) {
      if (used + text.length + 2 > bodyBudget) {
        cut = true;
        break;
      }
      lines[last.index] = `${lines[last.index]}  ${text}`;
      used += text.length + 2;
      continue;
    }
    const line = `${'  '.repeat(Math.max(0, depth) + 1)}${text}`;
    if (used + line.length + 1 > bodyBudget) {
      cut = true;
      break;
    }
    lines.push(line);
    last = { depth, leaf, index: lines.length - 1 };
    used += line.length + 1;
  }

  const output = [header, ...lines];
  if (cut || tree.truncated) {
    const ref = subtreeRef(nodes, start) ?? 'e1';
    output.push(
      `Tree cut at about 8,000 tokens (${tree.total} elements). Ask for a sub-tree: ` +
        `desktop.inspect({ window: ${JSON.stringify(tree.window)}, ref: "${ref}", depth: 3 }).`,
    );
  }
  const example = nodes.slice(start).find(isActionable)?.ref;
  output.push(
    `Snapshot ${tree.snapshot}. ` +
      (example
        ? `Act on a ref with desktop.act({ snapshot: "${tree.snapshot}", ref: "${example}", ` +
          `action: "click" }); `
        : 'Act on an actionable ref with desktop.act({ snapshot: ' +
          `"${tree.snapshot}", ref: "eN", action: "click" }); `) +
      'a ref goes stale when the window changes.',
  );
  return output.join('\n');
}

/** The matching elements as a flat list; `find` has no hierarchy to show. */
export function formatA11yFind(tree: DesktopA11yTree, query: DesktopA11yFindQuery): string {
  const target = [
    query.name && `name "${escape(query.name)}"`,
    query.role && `role "${escape(query.role)}"`,
  ]
    .filter(Boolean)
    .join(' and ');
  const header = `Matches for ${target} in window "${escape(tree.window)}" — snapshot ${tree.snapshot}`;
  const lines = [header];
  let used = header.length + 1;
  let cut = false;
  for (const node of tree.nodes) {
    const line = `  ${nodeLine(node)}`;
    if (used + line.length + 1 > A11Y_TREE_MAX_CHARS - NOTE_RESERVE) {
      cut = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (tree.nodes.length === 0) lines.push('  No elements match.');
  if (cut || tree.truncated) {
    lines.push(
      `Stopped at about 8,000 tokens (${tree.total} matches). Ask again with a narrower name or role.`,
    );
  }
  const example = tree.nodes.find(isActionable)?.ref;
  lines.push(
    `Snapshot ${tree.snapshot}. ` +
      (example
        ? `Act on a ref with desktop.act({ snapshot: "${tree.snapshot}", ref: "${example}", ` +
          `action: "click" }); `
        : 'Act on an actionable ref with desktop.act({ snapshot: ' +
          `"${tree.snapshot}", ref: "eN", action: "click" }); `) +
      'a ref goes stale when the window changes.',
  );
  return lines.join('\n');
}

/** One node as `role "name" [eN] = "value" (disabled)`, with a ref only when it is actionable. */
export function nodeLine(node: DesktopA11yTreeNode): string {
  const parts = [node.role];
  if (node.name) parts.push(`"${escape(node.name)}"`);
  if (isActionable(node)) parts.push(`[${node.ref}]`);
  if (node.value) parts.push(`= "${escape(node.value)}"`);
  const states = node.states.filter((state) => SHOWN_STATES.has(state));
  if (states.length) parts.push(`(${states.join(', ')})`);
  return parts.join(' ');
}

/** A ref is only shown when `desktop.act` can do something with it. */
function isActionable(node: DesktopA11yTreeNode): boolean {
  return node.actions.length > 0 || node.states.includes('editable');
}

/** A node with children, preferably near the top, to suggest as a sub-tree root. */
function subtreeRef(nodes: readonly DesktopA11yTreeNode[], start: number): string | undefined {
  for (let index = start; index < nodes.length; index++) {
    const next = nodes[index + 1];
    if (next && next.depth > nodes[index]!.depth) return nodes[index]!.ref;
  }
  return nodes[start]?.ref;
}

/** Quotes and newlines in a name or value must not break the line format. */
function escape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
}
