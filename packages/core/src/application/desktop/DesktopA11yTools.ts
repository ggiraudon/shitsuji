import { z } from 'zod/v4';
import { DESKTOP_A11Y_ACTIONS, DESKTOP_APPS, DESKTOP_KEYS } from '@shitsuji/sandbox-protocol';
import type {
  DesktopA11yFindQuery,
  DesktopA11yTree,
  DesktopCapability,
} from '../../ports/SandboxDriver.js';
import {
  BaseTool,
  type Tool,
  type ToolContext,
  type ToolEffect,
  type ToolOutput,
} from '../../ports/Tool.js';
import { formatA11yFind, formatA11yTree } from './formatTree.js';

const ref = z.string().regex(/^e\d{1,6}$/);
const snapshot = z.string().regex(/^s\d{1,6}$/);
const windowName = z.string().min(1).max(500);

const inspectSchema = z
  .object({
    /** A window title substring, or the application's name; omitted means the active window. */
    window: windowName.optional(),
    /** Find elements by name and/or role instead of reading the whole tree. */
    find: z
      .object({
        name: z.string().min(1).max(200).optional(),
        role: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    /** Start at this element of the current snapshot (a sub-tree). */
    ref: ref.optional(),
    depth: z.number().int().min(0).max(50).optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.find && args.find.name === undefined && args.find.role === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['find'],
        message: 'give a name or a role',
      });
    }
    if (args.find && args.ref) {
      ctx.addIssue({
        code: 'custom',
        path: ['ref'],
        message: 'find already locates the elements; do not give a ref too',
      });
    }
  });

const batchStepSchema = z
  .object({
    /** Characters to type in this step. */
    type: z.string().min(1).max(10_000).optional(),
    /** An allow-listed key or chord to press in this step. */
    key: z.enum(DESKTOP_KEYS).optional(),
  })
  .strict()
  .refine((step) => (step.type === undefined) !== (step.key === undefined), {
    message: 'give exactly one of type or key',
  });

const actSchema = z
  .object({
    /** The snapshot the ref came from, as desktop.inspect reported it. */
    snapshot: snapshot.optional(),
    /** Required for click, set_text and type; a key press may act on the focused window. */
    ref: ref.optional(),
    action: z.enum([...DESKTOP_A11Y_ACTIONS, 'type', 'key', 'launch_app'] as const).optional(),
    /** The replacement text for set_text or the characters to type. */
    text: z.string().max(10_000).optional(),
    /** The key or chord for `key`, from the desktop allow-list. */
    key: z.enum(DESKTOP_KEYS).optional(),
    /** An allowed app for launch_app. */
    app: z.enum(DESKTOP_APPS).optional(),
    /** A short keyboard sequence run as one call; stops at the first failure. */
    steps: z.array(batchStepSchema).min(1).max(20).optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.steps && args.action !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['steps'], message: 'cannot be combined with action' });
    }
    if (!args.steps && args.action === undefined) {
      ctx.addIssue({ code: 'custom', path: ['action'], message: 'or steps is required' });
    }
    if (args.steps) {
      if (args.ref !== undefined && args.snapshot === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['snapshot'],
          message: 'is required when steps focus a ref',
        });
      }
      for (const field of ['text', 'key', 'app'] as const) {
        if (args[field] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: 'is only allowed with an action',
          });
        }
      }
      return;
    }
    if (args.action === 'key' || args.action === 'launch_app') {
      // These do not need a ref or a snapshot.
    } else if (args.action !== undefined && args.snapshot === undefined) {
      ctx.addIssue({ code: 'custom', path: ['snapshot'], message: 'is required for this action' });
    }
    if (args.action !== 'key' && args.action !== 'launch_app' && args.ref === undefined) {
      ctx.addIssue({ code: 'custom', path: ['ref'], message: 'is required for this action' });
    }
    if ((args.action === 'set_text' || args.action === 'type') && args.text === undefined) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'is required for this action' });
    }
    if (args.action !== 'set_text' && args.action !== 'type' && args.text !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'is only allowed with set_text or type',
      });
    }
    if (args.action === 'key' && args.key === undefined) {
      ctx.addIssue({ code: 'custom', path: ['key'], message: 'is required with key' });
    }
    if (args.action !== 'key' && args.key !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['key'], message: 'is only allowed with key' });
    }
    if (args.action === 'launch_app' && args.app === undefined) {
      ctx.addIssue({ code: 'custom', path: ['app'], message: 'is required with launch_app' });
    }
    if (args.action !== 'launch_app' && args.app !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['app'], message: 'is only allowed with launch_app' });
    }
  });

type InspectArgs = z.infer<typeof inspectSchema>;
type ActArgs = z.infer<typeof actSchema>;

/**
 * `desktop.inspect` (S54): reads a window's AT-SPI tree as the compact text from F10, or finds
 * elements by name or role. Structure before pixels: the result is text, not a screenshot, and the
 * tool is marked untrusted because every name and value comes from an application.
 */
export class DesktopInspectTool extends BaseTool<typeof inspectSchema> {
  readonly name = 'desktop.inspect';
  readonly description =
    'Read a desktop window as an accessibility tree with [eN] refs and a snapshot id, or find ' +
    'elements by name or role. Prefer this over screenshots for desktop apps; use the ref with ' +
    'desktop.act. If the tree is cut, ask for a sub-tree with window, ref and depth.';
  readonly input = inspectSchema;
  override readonly target = 'desktop' as const;
  override readonly untrustedOutput = true;
  readonly effect: ToolEffect = 'read';

  constructor(private readonly desktop: DesktopCapability) {
    super();
  }

  async run(args: InspectArgs, ctx: ToolContext): Promise<ToolOutput> {
    try {
      const tree = await this.read(args, ctx);
      const content = args.find ? formatA11yFind(tree, toFindQuery(args)) : formatA11yTree(tree);
      return {
        content,
        data: {
          window: tree.window,
          app: tree.app,
          snapshot: tree.snapshot,
          elements: tree.nodes.length,
          total: tree.total,
          truncated: tree.truncated,
          ...(args.find && { find: args.find }),
        },
      };
    } catch (error) {
      return {
        content: `The accessibility tree could not be read: ${messageOf(error)}`,
        isError: true,
      };
    }
  }

  private read(args: InspectArgs, ctx: ToolContext): Promise<DesktopA11yTree> {
    if (args.find) {
      return this.desktop.find(toFindQuery(args), ctx.signal);
    }
    return this.desktop.inspect(
      {
        ...(args.window && { window: args.window }),
        ...(args.ref && { ref: args.ref }),
        ...(args.depth !== undefined && { depth: args.depth }),
      },
      ctx.signal,
    );
  }
}

/**
 * `desktop.act` (S54, S56): clicks an element, sets its text, types into it, or presses a key, then
 * returns a fresh tree. The tree targets a widget; typing and key presses use the desktop keyboard
 * after focusing the ref, which is what makes a Calc cell commit. All actions are local writes; a
 * Chromium click stays `write_local` until F09 (#136).
 */
export class DesktopActTool extends BaseTool<typeof actSchema> {
  readonly name = 'desktop.act';
  readonly description =
    'Click an element, set its text, type into it, press a key, or launch an allowed app using a ref ' +
    'from desktop.inspect. The result is a fresh tree and snapshot. A ref whose window changed is ' +
    'refused with "stale, take a new snapshot".';
  readonly input = actSchema;
  override readonly target = 'desktop' as const;
  override readonly untrustedOutput = true;
  readonly effect: ToolEffect = 'write_local';

  constructor(
    private readonly desktop: DesktopCapability,
    private readonly isOwner: () => boolean = () => false,
  ) {
    super();
  }

  async run(args: ActArgs, ctx: ToolContext): Promise<ToolOutput> {
    if (this.isOwner()) {
      return {
        content:
          'The owner has control of the desktop. Reading the tree and screenshots still works, ' +
          'but the agent cannot click, type, launch or set text until the owner gives it back.',
        isError: true,
      };
    }
    if (args.steps) return this.runSteps(args, ctx);

    const action = args.action!;
    let acted: string;
    let window = '';
    let app: string | undefined;
    let role = 'keyboard';
    let name: string | undefined;
    const ref = args.ref;
    try {
      if (action === 'launch_app') {
        await this.desktop.act({ kind: 'launch_app', app: args.app! }, ctx.signal);
        acted = `Launched ${args.app}.`;
        app = args.app;
      } else if (action === 'key') {
        await this.desktop.act({ kind: 'key', key: args.key! }, ctx.signal);
        acted = `Pressed ${args.key}.`;
      } else {
        const result = await this.desktop.actOnElement(
          {
            snapshot: args.snapshot!,
            ref: args.ref!,
            action: action === 'type' ? 'click' : action,
            ...(action === 'set_text' && args.text !== undefined && { text: args.text }),
          },
          ctx.signal,
        );
        role = result.role;
        name = result.name;
        app = result.app;
        if (action === 'type') {
          await this.desktop.act({ kind: 'type', text: args.text! }, ctx.signal);
          acted =
            `Typed ${args.text!.length} characters into [${args.ref}] ` +
            `${describe(result.role, result.name)} in "${result.window}".`;
        } else if (action === 'click') {
          acted = `Clicked [${args.ref}] ${describe(result.role, result.name)} in "${result.window}".`;
        } else {
          acted =
            `Set the text of [${args.ref}] ${describe(result.role, result.name)} ` +
            `(${args.text?.length ?? 0} characters).`;
        }
        window = result.window;
      }
    } catch (error) {
      return {
        content: `The action was not performed: ${messageOf(error)}`,
        isError: true,
      };
    }

    let tree: DesktopA11yTree | undefined;
    try {
      tree =
        action === 'key' || action === 'launch_app'
          ? await this.desktop.inspect({}, ctx.signal)
          : await this.desktop.inspect({ window }, ctx.signal);
      window ??= tree.window;
    } catch {
      // The action itself succeeded; a failed re-read only means no fresh tree to show.
    }
    return {
      content: [acted, tree ? formatA11yTree(tree) : 'The tree could not be read again.'].join(
        '\n',
      ),
      data: {
        action: args.action,
        ...(ref && { ref }),
        ...(args.key && { key: args.key }),
        snapshot: tree?.snapshot ?? args.snapshot,
        window: window ?? '',
        ...(app && { app }),
        role,
        ...(name && { name }),
      },
    };
  }

  /** One trust call for a short keyboard sequence; stops at the first failing step. */
  private async runSteps(args: ActArgs, ctx: ToolContext): Promise<ToolOutput> {
    const steps = args.steps!;
    try {
      if (args.ref !== undefined) {
        if (args.snapshot === undefined) {
          return { content: 'Focusing a ref needs its snapshot.', isError: true };
        }
        await this.desktop.actOnElement(
          { snapshot: args.snapshot, ref: args.ref, action: 'click' },
          ctx.signal,
        );
      }
    } catch (error) {
      return { content: `Focusing [${args.ref}] failed: ${messageOf(error)}`, isError: true };
    }

    for (const [index, step] of steps.entries()) {
      try {
        if (step.type !== undefined) {
          await this.desktop.act({ kind: 'type', text: step.type }, ctx.signal);
        } else {
          await this.desktop.act({ kind: 'key', key: step.key! }, ctx.signal);
        }
      } catch (error) {
        const what =
          step.type !== undefined ? `type ${JSON.stringify(step.type)}` : `key ${step.key}`;
        return {
          content: `Step ${index + 1} of ${steps.length} (${what}) failed: ${messageOf(error)}`,
          isError: true,
        };
      }
    }

    let tree: DesktopA11yTree | undefined;
    try {
      tree = await this.desktop.inspect({}, ctx.signal);
    } catch {
      // The steps succeeded; a failed re-read only means no fresh tree to show.
    }
    return {
      content: [
        `Ran ${steps.length} steps${args.ref ? ` after focusing [${args.ref}]` : ''}.`,
        tree ? formatA11yTree(tree) : 'The tree could not be read again.',
      ].join('\n'),
      data: {
        steps: steps.length,
        ...(args.ref && { ref: args.ref }),
        ...(tree && { snapshot: tree.snapshot, window: tree.window }),
        role: 'keyboard',
      },
    };
  }
}

/** The two structure-first tools, registered only when the driver advertises accessibility. */
export function desktopA11yTools(
  desktop: DesktopCapability,
  isOwner: () => boolean = () => false,
): Tool[] {
  return [new DesktopInspectTool(desktop), new DesktopActTool(desktop, isOwner)];
}

function toFindQuery(args: InspectArgs): DesktopA11yFindQuery {
  return {
    ...(args.window && { window: args.window }),
    ...(args.find?.name && { name: args.find.name }),
    ...(args.find?.role && { role: args.find.role }),
  };
}

function describe(role: string, name: string | undefined): string {
  return name ? `${role} "${name}"` : role;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
