import { z } from 'zod/v4';
import { DESKTOP_APPS, DESKTOP_KEYS, DESKTOP_A11Y_PRESS_ACTIONS } from '@shitsuji/sandbox-protocol';
import type {
  DesktopA11yFindQuery,
  DesktopA11yTree,
  DesktopCapability,
  DesktopWindow,
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
    /** Search every window of this app (dialogs included); only with find. */
    app: z.string().min(1).max(200).optional(),
    /** Find elements by name and/or role instead of reading the whole tree. */
    find: z
      .object({
        /** Match the element's accessible name; a substring. */
        name: z.string().min(1).max(200).optional(),
        /** Match the element's role, e.g. `push button` or `cell`. */
        role: z.string().min(1).max(200).optional(),
        /** Match the whole name and role instead of a substring. */
        exact: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Start at this element of the current snapshot (a sub-tree). */
    ref: ref.optional(),
    /** How many levels below the start to read; the whole tree when omitted. */
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
    if (args.app !== undefined && args.find === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['app'],
        message: 'is only allowed with find',
      });
    }
    if (args.app !== undefined && args.window !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['app'],
        message: 'searches the whole app; drop the window',
      });
    }
  });

const waitSchema = z
  .object({
    /** A window title substring to wait for; required without find. */
    window: windowName.optional(),
    /** Search every window of this app; only with find. */
    app: z.string().min(1).max(200).optional(),
    /** An element to wait for, by name and/or role. */
    find: z
      .object({
        name: z.string().min(1).max(200).optional(),
        role: z.string().min(1).max(200).optional(),
        exact: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Wait for the target to be there (the default) or gone. */
    state: z.enum(['present', 'absent']).optional(),
    /** How long to wait; a timeout is a normal result. 10 s when unset, at most 60 s. */
    timeoutMs: z.number().int().min(100).max(60_000).optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.find && args.find.name === undefined && args.find.role === undefined) {
      ctx.addIssue({ code: 'custom', path: ['find'], message: 'give a name or a role' });
    }
    if (args.find === undefined && args.window === undefined) {
      ctx.addIssue({ code: 'custom', path: ['window'], message: 'or find is required' });
    }
    if (args.app !== undefined && args.find === undefined) {
      ctx.addIssue({ code: 'custom', path: ['app'], message: 'is only allowed with find' });
    }
    if (args.app !== undefined && args.window !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['app'],
        message: 'searches the whole app; drop the window',
      });
    }
  });

const windowsSchema = z.object({}).strict();

const windowActionSchema = z
  .object({
    /** The window id (`0x…`) or a title substring. */
    window: windowName,
    action: z.enum(['move', 'resize', 'focus']),
    x: z.number().int().min(-100_000).max(100_000).optional(),
    y: z.number().int().min(-100_000).max(100_000).optional(),
    width: z.number().int().min(50).max(100_000).optional(),
    height: z.number().int().min(50).max(100_000).optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (args.action === 'move' && (args.x === undefined || args.y === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['x'], message: 'is required for move' });
    }
    if (args.action === 'resize' && (args.width === undefined || args.height === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['width'], message: 'is required for resize' });
    }
    if (args.action !== 'move' && args.y !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['y'], message: 'is only for move' });
    }
    if (args.action === 'focus' && args.x !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['x'], message: 'is only for move' });
    }
    if (args.action !== 'resize' && args.width !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['width'], message: 'is only for resize' });
    }
    if (args.action !== 'resize' && args.height !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['height'], message: 'is only for resize' });
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

const pressAction = z
  .string()
  .max(200)
  .regex(
    new RegExp(
      `^(${DESKTOP_A11Y_PRESS_ACTIONS.join('|')})(\\|(${DESKTOP_A11Y_PRESS_ACTIONS.join('|')})){0,3}$`,
    ),
    'is not a press action list',
  );

const actSchema = z
  .object({
    /** The snapshot the ref came from, as desktop.inspect reported it. */
    snapshot: snapshot.optional(),
    /** Required for click, set_text and type; a key press may act on the focused window. */
    ref: ref.optional(),
    /**
     * One action: a press list such as `press|click` (each name tried in order, and the result says
     * which ran), `set_text`, `type`, `key` or `launch_app`; the batch form uses `steps` instead.
     */
    action: z
      .union([
        pressAction,
        z.literal('set_text'),
        z.literal('type'),
        z.literal('key'),
        z.literal('launch_app'),
      ])
      .optional(),
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
type WaitArgs = z.infer<typeof waitSchema>;
type WindowActionArgs = z.infer<typeof windowActionSchema>;
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
    'elements by name or role. Add app to search every window of that app, dialogs included; add ' +
    'find.exact to match the whole name. Prefer this over screenshots for desktop apps; use the ' +
    'ref with desktop.act. If the tree is cut, ask for a sub-tree with window, ref and depth.';
  readonly input = inspectSchema;
  override readonly target = 'desktop' as const;
  override readonly untrustedOutput = true;
  readonly effect: ToolEffect = 'read';

  constructor(
    /** The driver's desktop: the tree routes this tool reads. */
    private readonly desktop: DesktopCapability,
  ) {
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
          ...(tree.windows && { windows: tree.windows }),
          snapshot: tree.snapshot,
          elements: tree.nodes.length,
          total: tree.total,
          truncated: tree.truncated,
          ...(args.find && { find: args.find }),
        },
      };
    } catch (error) {
      return errorWithRemedy(
        `The accessibility tree could not be read: ${messageOf(error)}.`,
        'name the window or app, e.g. desktop.inspect({ window: "Save" }) or ' +
          'desktop.inspect({ app: "soffice", find: { name: "OK" } }); if it still fails, ' +
          'take a screenshot with computer.act.',
      );
    }
  }

  /** Reads the matching tree; a find query uses the find route, everything else the tree route. */
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
 * `desktop.wait` (#151): waits until an element (find) or a window title is present or absent. A
 * timeout is a normal result, not an error: it names what was being waited for so the model can
 * decide what to do next, and it replaces inspect → inspect after a launch or a Save click.
 */
export class DesktopWaitTool extends BaseTool<typeof waitSchema> {
  readonly name = 'desktop.wait';
  readonly description =
    'Wait until an element (find by name or role, optionally across an app) or a window title is ' +
    'present or absent, then return it. A timeout is a normal result, not an error. Use this after ' +
    'launching an app or clicking a button that opens a dialog instead of inspecting in a loop.';
  readonly input = waitSchema;
  override readonly target = 'desktop' as const;
  override readonly untrustedOutput = true;
  readonly effect: ToolEffect = 'read';

  constructor(
    private readonly desktop: DesktopCapability,
    private readonly pollMs = 250,
  ) {
    super();
  }

  async run(args: WaitArgs, ctx: ToolContext): Promise<ToolOutput> {
    const state = args.state ?? 'present';
    const timeoutMs = args.timeoutMs ?? 10_000;
    const started = Date.now();
    const deadline = started + timeoutMs;
    for (;;) {
      const check = await this.check(args, state, ctx);
      if (check.met) {
        const waitedMs = Date.now() - started;
        const head =
          state === 'present'
            ? `Present after ${seconds(waitedMs)}.`
            : `Gone after ${seconds(waitedMs)}.`;
        const content = check.content ? `${head}\n${check.content}` : head;
        return {
          content,
          data: {
            state,
            present: state === 'present',
            timedOut: false,
            waitedMs,
            ...(check.tree && {
              snapshot: check.tree.snapshot,
              window: check.tree.window,
              app: check.tree.app,
            }),
          },
        };
      }
      if (Date.now() >= deadline) break;
      try {
        await sleep(this.pollMs, ctx.signal);
      } catch {
        break;
      }
    }
    const waitedMs = Date.now() - started;
    return {
      content:
        `Timed out after ${seconds(waitedMs)} waiting for ${targetOf(args)} to be ${state}. ` +
        'The desktop did not show it; check the window title or inspect the app again.',
      data: { state, present: false, timedOut: true, waitedMs },
    };
  }

  private async check(
    args: WaitArgs,
    state: 'present' | 'absent',
    ctx: ToolContext,
  ): Promise<{ met: boolean; content?: string; tree?: DesktopA11yTree }> {
    if (args.find) {
      const query = toWaitFindQuery(args);
      let tree: DesktopA11yTree;
      try {
        tree = await this.desktop.find(query, ctx.signal);
      } catch {
        return { met: false }; // the window may not exist yet; keep waiting
      }
      const present = tree.nodes.length > 0;
      const met = state === 'present' ? present : !present;
      if (!met || !present) return { met, tree };
      return {
        met,
        tree,
        content: formatA11yFind(tree, query),
      };
    }
    const needle = (args.window ?? '').toLowerCase();
    let windows: readonly DesktopWindow[];
    try {
      windows = await this.desktop.windows(ctx.signal);
    } catch {
      return { met: false };
    }
    const matches = windows.filter(
      (item) => item.title.trim() !== '' && item.title.toLowerCase().includes(needle),
    );
    const present = matches.length > 0;
    const met = state === 'present' ? present : !present;
    return {
      met,
      ...(met &&
        present && {
          content: matches.map((item) => windowLine(item)).join('\n'),
        }),
    };
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function targetOf(args: WaitArgs): string {
  if (args.find) {
    const parts = [
      args.find.name && `name "${args.find.name}"`,
      args.find.role && `role "${args.find.role}"`,
    ].filter(Boolean);
    return `an element matching ${parts.join(' and ')}`;
  }
  return `a window titled "${args.window ?? ''}"`;
}

function toWaitFindQuery(args: WaitArgs): DesktopA11yFindQuery {
  return {
    ...(args.window && { window: args.window }),
    ...(args.app && { app: args.app }),
    ...(args.find?.name && { name: args.find.name }),
    ...(args.find?.role && { role: args.find.role }),
    ...(args.find?.exact !== undefined && { exact: args.find.exact }),
  };
}

/**
 * `desktop.windows` (#151): the open windows with their app, size, position and id, dialogs
 * included, so the model can pick the window it means or fix one that is off screen.
 */
export class DesktopWindowsTool extends BaseTool<typeof windowsSchema> {
  readonly name = 'desktop.windows';
  readonly description =
    'List the desktop windows with their application, size, position and id, dialogs included. ' +
    'Use desktop.window to move, resize or focus one.';
  readonly input = windowsSchema;
  override readonly target = 'desktop' as const;
  readonly effect: ToolEffect = 'read';

  constructor(private readonly desktop: DesktopCapability) {
    super();
  }

  async run(_args: z.infer<typeof windowsSchema>, ctx: ToolContext): Promise<ToolOutput> {
    let windows: readonly DesktopWindow[];
    try {
      windows = await this.desktop.windows(ctx.signal);
    } catch (error) {
      return errorWithRemedy(
        `The windows could not be listed: ${messageOf(error)}.`,
        'try again; if it still fails, take a screenshot with computer.act.',
      );
    }
    const shown = windows.filter(isShownWindow);
    if (shown.length === 0) return { content: 'No windows are open.', data: { windows: 0 } };
    return {
      content: [
        `${shown.length} window${shown.length === 1 ? '' : 's'}:`,
        ...shown.map((item) => windowLine(item)),
      ].join('\n'),
      data: { windows: shown.length },
    };
  }
}

/**
 * `desktop.window` (#151): moves, resizes or focuses one window, on top of S56's automatic fitting.
 * The reply is the window's geometry after the change.
 */
export class DesktopWindowTool extends BaseTool<typeof windowActionSchema> {
  readonly name = 'desktop.window';
  readonly description =
    'Move, resize or focus one window by id or title substring. The result is its geometry after ' +
    'the change, so an off-screen window can be brought back without guessing a pixel.';
  readonly input = windowActionSchema;
  override readonly target = 'desktop' as const;
  readonly effect: ToolEffect = 'write_local';

  constructor(
    /** The driver's desktop: element actions and the fresh tree after them. */
    private readonly desktop: DesktopCapability,
    /** True while the owner holds the desktop, which refuses every write. */
    private readonly isOwner: () => boolean = () => false,
  ) {
    super();
  }

  async run(args: WindowActionArgs, ctx: ToolContext): Promise<ToolOutput> {
    if (this.isOwner()) {
      return errorWithRemedy(
        'The owner has control of the desktop, so the agent cannot move, resize or focus windows.',
        'list the windows or read the tree meanwhile, and ask the owner to give control back.',
      );
    }
    if (!this.desktop.windowAction) {
      return errorWithRemedy(
        'This desktop cannot move windows.',
        'use desktop.inspect to work in the window as it is, or take a screenshot with computer.act.',
      );
    }
    let windows: readonly DesktopWindow[];
    try {
      windows = await this.desktop.windowAction(
        {
          window: args.window,
          action: args.action,
          ...(args.x !== undefined && { x: args.x }),
          ...(args.y !== undefined && { y: args.y }),
          ...(args.width !== undefined && { width: args.width }),
          ...(args.height !== undefined && { height: args.height }),
        },
        ctx.signal,
      );
    } catch (error) {
      return errorWithRemedy(
        `The window was not ${args.action === 'move' ? 'moved' : args.action === 'resize' ? 'resized' : 'focused'}: ${messageOf(error)}.`,
        'run desktop.windows and use the window id or a longer title substring.',
      );
    }
    const target =
      windows.find((item) => item.id === args.window) ??
      windows.find((item) => item.title.toLowerCase().includes(args.window.toLowerCase()));
    const what = target ? windowLine(target) : `window "${args.window}"`;
    const acted =
      args.action === 'focus'
        ? `Focused ${what}.`
        : args.action === 'move'
          ? `Moved ${what} to ${args.x},${args.y}.`
          : `Resized ${what} to ${args.width}x${args.height}.`;
    return {
      content: acted,
      data: {
        action: args.action,
        window: target?.title ?? args.window,
        ...(target && {
          geometry: { x: target.x, y: target.y, width: target.width, height: target.height },
        }),
      },
    };
  }
}

function isShownWindow(item: DesktopWindow): boolean {
  return (
    item.title.trim() !== '' &&
    item.title !== 'Desktop' &&
    !['xfce4-panel', 'xfwm4', 'xfdesktop', 'xfsettingsd'].includes(item.app ?? '')
  );
}

function windowLine(item: DesktopWindow): string {
  const app = item.app ? ` (${item.app})` : '';
  return `window "${item.title}"${app} ${item.width}x${item.height} at ${item.x},${item.y} [${item.id}]`;
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
    'from desktop.inspect. The result says what got the focus and which windows appeared or closed; ' +
    'it does not re-read the whole window, so inspect again when you need fresh refs. A ref whose ' +
    'window changed is refused with "stale, take a new snapshot".';
  readonly input = actSchema;
  override readonly target = 'desktop' as const;
  override readonly untrustedOutput = true;
  readonly effect: ToolEffect = 'write_local';

  constructor(
    private readonly desktop: DesktopCapability,
    private readonly isOwner: () => boolean = () => false,
    private readonly options: { pollMs?: number } = {},
  ) {
    super();
  }

  async run(args: ActArgs, ctx: ToolContext): Promise<ToolOutput> {
    if (this.isOwner()) {
      return errorWithRemedy(
        'The owner has control of the desktop, so the agent cannot click, type, launch or set text.',
        'read the tree or a screenshot meanwhile, and ask the owner to give control back.',
      );
    }
    if (args.steps) return this.runSteps(args, ctx);

    const action = args.action!;
    const before = await this.listWindows(ctx);
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
        acted = `Pressed ${args.key} (sent, unconfirmed; no retry).`;
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
        const ran = result.ran ? ` (ran ${result.ran})` : '';
        const unsure = result.confirmed === false ? ' (sent, unconfirmed; no retry)' : '';
        if (action === 'type') {
          await this.desktop.act({ kind: 'type', text: args.text! }, ctx.signal);
          acted =
            `Typed ${args.text!.length} characters into [${args.ref}] ` +
            `${describe(result.role, result.name)} in "${result.window}" (sent, unconfirmed; no retry).`;
        } else if (action === 'click') {
          acted =
            `Clicked [${args.ref}] ${describe(result.role, result.name)} ` +
            `in "${result.window}"${ran}${unsure}.`;
        } else if (action === 'set_text') {
          acted =
            `Set the text of [${args.ref}] ${describe(result.role, result.name)} ` +
            `(${args.text?.length ?? 0} characters)${unsure}.`;
        } else {
          acted =
            `Ran ${action} on [${args.ref}] ${describe(result.role, result.name)} ` +
            `in "${result.window}"${ran}${unsure}.`;
        }
        window = result.window;
      }
    } catch (error) {
      return actionError(error);
    }

    const after =
      action === 'launch_app' ? await this.waitForWindow(before, ctx) : await this.listWindows(ctx);
    const changes = await this.reportChanges(before, after, ctx);
    const focus =
      changes.focus ??
      (ref !== undefined && role !== 'keyboard'
        ? `Focus: ${describe(role, name)} [${ref}] in "${window}".`
        : undefined);
    const lines = [acted, ...changes.lines];
    if (focus) lines.push(focus);
    if (!changes.snapshot && args.snapshot !== undefined) {
      lines.push(
        `The tree was not re-read: other refs from snapshot ${args.snapshot} still work; ` +
          'inspect again when you need fresh ones.',
      );
    }
    return {
      content: lines.join('\n'),
      data: {
        action: args.action,
        ...(ref && { ref }),
        ...(args.key && { key: args.key }),
        snapshot: changes.snapshot ?? args.snapshot,
        window: changes.window ?? window,
        ...((changes.app ?? app) && { app: changes.app ?? app }),
        role,
        ...(name && { name }),
        appeared: changes.appeared,
        closed: changes.closed,
      },
    };
  }

  /** One trust call for a short keyboard sequence; stops at the first failing step. */
  private async runSteps(args: ActArgs, ctx: ToolContext): Promise<ToolOutput> {
    const steps = args.steps!;
    const before = await this.listWindows(ctx);
    try {
      if (args.ref !== undefined) {
        if (args.snapshot === undefined) {
          return errorWithRemedy(
            `Focusing [${args.ref}] needs the snapshot it came from.`,
            'pass the snapshot desktop.inspect reported with that ref.',
          );
        }
        await this.desktop.actOnElement(
          { snapshot: args.snapshot, ref: args.ref, action: 'click' },
          ctx.signal,
        );
      }
    } catch (error) {
      return errorWithRemedy(
        `Focusing [${args.ref}] failed: ${messageOf(error)}.`,
        'run desktop.inspect again and focus a ref from the new snapshot.',
      );
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
        return errorWithRemedy(
          `Step ${index + 1} of ${steps.length} (${what}) failed: ${messageOf(error)}.`,
          'the steps before it were sent; inspect the window before trying again, and do not ' +
            'resend the whole batch.',
        );
      }
    }

    const after = await this.listWindows(ctx);
    const changes = await this.reportChanges(before, after, ctx);
    const lines = [
      `Ran ${steps.length} steps${args.ref ? ` after focusing [${args.ref}]` : ''} ` +
        '(keys and typed text are sent; the app does not confirm them).',
      ...changes.lines,
    ];
    if (changes.focus) lines.push(changes.focus);
    return {
      content: lines.join('\n'),
      data: {
        steps: steps.length,
        ...(args.ref && { ref: args.ref }),
        ...(changes.snapshot && { snapshot: changes.snapshot }),
        ...(changes.window && { window: changes.window }),
        appeared: changes.appeared,
        closed: changes.closed,
        role: 'keyboard',
      },
    };
  }

  /** The top-level windows, or undefined when the list itself fails (never an action failure). */
  private async listWindows(ctx: ToolContext): Promise<readonly DesktopWindow[] | undefined> {
    try {
      return await this.desktop.windows(ctx.signal);
    } catch {
      return undefined;
    }
  }

  /**
   * A launched app takes a moment to map its window; poll for a new one, bounded, then report what
   * there is. This waits on the desktop, it does not repeat the launch.
   */
  private async waitForWindow(
    before: readonly DesktopWindow[] | undefined,
    ctx: ToolContext,
  ): Promise<readonly DesktopWindow[] | undefined> {
    let current = await this.listWindows(ctx);
    if (!before || !current) return current;
    const deadline = Date.now() + 5_000;
    while (current && !hasNewWindow(before, current) && Date.now() < deadline) {
      try {
        await sleep(this.options.pollMs ?? 250, ctx.signal);
      } catch {
        break;
      }
      current = await this.listWindows(ctx);
    }
    return current;
  }

  /** What appeared or closed, with a small tree for each new window; never re-reads the old window. */
  private async reportChanges(
    before: readonly DesktopWindow[] | undefined,
    after: readonly DesktopWindow[] | undefined,
    ctx: ToolContext,
  ): Promise<{
    lines: string[];
    appeared: string[];
    closed: string[];
    focus?: string;
    snapshot?: string;
    window?: string;
    app?: string;
  }> {
    const lines: string[] = [];
    if (!before || !after) {
      return { lines, appeared: [], closed: [] };
    }
    const appearedWindows = interesting(after).filter((item) => !hasWindow(before, item));
    const closed = interesting(before).filter((item) => !hasWindow(after, item));
    const appeared: string[] = [];
    let snapshot: string | undefined;
    let window: string | undefined;
    let app: string | undefined;
    let focus: string | undefined;
    for (const item of appearedWindows.slice(0, 3)) {
      appeared.push(item.title);
      let tree: DesktopA11yTree | undefined;
      try {
        tree = await this.desktop.inspect({ window: item.title }, ctx.signal);
      } catch {
        // The window may still be drawing; the model can inspect it next.
      }
      if (!tree) {
        lines.push(`New window "${item.title}" appeared (its tree is not readable yet).`);
        continue;
      }
      lines.push(`New window appeared: ${tree.app} — "${tree.window}".`);
      lines.push(formatA11yTree(tree));
      snapshot ??= tree.snapshot;
      window ??= tree.window;
      app ??= tree.app;
      const focused = tree.nodes.find((node) => node.states.includes('focused'));
      focus ??=
        focused &&
        `Focus: ${describe(focused.role, focused.name)} [${focused.ref}] in "${tree.window}".`;
    }
    for (const item of closed.slice(0, 3)) {
      lines.push(`Closed window "${item.title}".`);
    }
    const closedTitles = closed.map((item) => item.title);
    if (appeared.length === 0 && closedTitles.length === 0) {
      lines.push('No window appeared or closed.');
    }
    return {
      lines,
      appeared,
      closed: closedTitles,
      ...(focus && { focus }),
      ...(snapshot && { snapshot }),
      ...(window && { window }),
      ...(app && { app }),
    };
  }
}

function interesting(windows: readonly DesktopWindow[]): DesktopWindow[] {
  return windows.filter((item) => item.title.trim() !== '' && item.title !== 'Desktop');
}

function hasWindow(windows: readonly DesktopWindow[], item: DesktopWindow): boolean {
  return windows.some((candidate) => candidate.id === item.id);
}

function hasNewWindow(before: readonly DesktopWindow[], after: readonly DesktopWindow[]): boolean {
  return interesting(after).some((item) => !hasWindow(before, item));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('The wait was aborted.'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('The wait was aborted.'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** The two structure-first tools, registered only when the driver advertises accessibility. */
export function desktopA11yTools(
  desktop: DesktopCapability,
  isOwner: () => boolean = () => false,
): Tool[] {
  return [
    new DesktopInspectTool(desktop),
    new DesktopWaitTool(desktop),
    new DesktopWindowsTool(desktop),
    new DesktopWindowTool(desktop, isOwner),
    new DesktopActTool(desktop, isOwner),
  ];
}

function toFindQuery(args: InspectArgs): DesktopA11yFindQuery {
  return {
    ...(args.window && { window: args.window }),
    ...(args.app && { app: args.app }),
    ...(args.find?.name && { name: args.find.name }),
    ...(args.find?.role && { role: args.find.role }),
    ...(args.find?.exact !== undefined && { exact: args.find.exact }),
  };
}

function describe(role: string, name: string | undefined): string {
  return name ? `${role} "${name}"` : role;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every desktop tool error is two lines: what failed, then the remedy (#151). */
function errorWithRemedy(what: string, remedy: string): ToolOutput {
  const sentence = (text: string) => (text.trimEnd().endsWith('.') ? text.trimEnd() : `${text}.`);
  return { content: `${sentence(what)}\nRemedy: ${sentence(remedy)}`, isError: true };
}

/** An act failure: a stale ref needs a new snapshot; anything else needs a fresh look first. */
function actionError(error: unknown): ToolOutput {
  const detail = messageOf(error);
  if (/stale, take a new snapshot/i.test(detail)) {
    return errorWithRemedy(
      `The action was not performed: ${detail}.`,
      'run desktop.inspect on that window again and use a ref from the new snapshot.',
    );
  }
  return errorWithRemedy(
    `The action was not performed: ${detail}.`,
    'run desktop.inspect on the window again and retry with a current ref; do not guess coordinates.',
  );
}
