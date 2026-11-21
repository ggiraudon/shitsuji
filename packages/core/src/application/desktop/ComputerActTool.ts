import { z } from 'zod/v4';
import { DESKTOP_APPS, DESKTOP_KEYS, DESKTOP_MAX_LONG_SIDE } from '@shitsuji/sandbox-protocol';
import type {
  DesktopAction,
  DesktopCapability,
  DesktopRect,
  SandboxFiles,
} from '../../ports/SandboxDriver.js';
import {
  BaseTool,
  type Tool,
  type ToolContext,
  type ToolEffect,
  type ToolOutput,
} from '../../ports/Tool.js';

const point = z.number().int().min(0).max(100_000);
const button = z.enum(['left', 'right', 'middle']).optional();
const region = z
  .object({
    x: point,
    y: point,
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
  })
  .strict();

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('screenshot') }).strict(),
  z.object({ action: z.literal('click'), x: point, y: point, button }).strict(),
  z.object({ action: z.literal('double_click'), x: point, y: point }).strict(),
  z.object({ action: z.literal('right_click'), x: point, y: point }).strict(),
  z.object({ action: z.literal('move'), x: point, y: point }).strict(),
  z
    .object({
      action: z.literal('drag'),
      fromX: point,
      fromY: point,
      toX: point,
      toY: point,
      button,
    })
    .strict(),
  z
    .object({
      action: z.literal('scroll'),
      x: point,
      y: point,
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().min(1).max(20).default(1),
    })
    .strict(),
  z.object({ action: z.literal('type'), text: z.string().min(1).max(10_000) }).strict(),
  z.object({ action: z.literal('key'), key: z.enum(DESKTOP_KEYS) }).strict(),
  z.object({ action: z.literal('wait'), ms: z.number().int().min(1).max(10_000) }).strict(),
  z.object({ action: z.literal('launch_app'), app: z.enum(DESKTOP_APPS) }).strict(),
  z.object({ action: z.literal('ocr'), region: region.optional() }).strict(),
]);

type ComputerAction = z.infer<typeof actionSchema>;

const READ_ACTIONS = new Set<ComputerAction['action']>(['screenshot', 'move', 'ocr']);

/**
 * `computer.act` (S53): clicks, keys, typing, launch and OCR on the desktop. Every call ends with a
 * fresh scaled PNG written under `sessions/<sessionId>/images/` and returned as an S52 reference; the
 * text states the screenshot size and scale so coordinates map back.
 */
export class ComputerActTool extends BaseTool<typeof actionSchema> {
  readonly name = 'computer.act';
  readonly description =
    'Drive the desktop with pixels: screenshot, click/double/right, move, drag, scroll, type, key, wait, ' +
    'launch an allowed app, or OCR. Every result includes a fresh scaled screenshot.';
  readonly input = actionSchema;
  override readonly target = 'desktop' as const;
  override readonly untrustedOutput = true;
  private shots = 0;
  /** The scale of the last screenshot the model saw, per session; input coordinates use it. */
  private readonly screenshotScales = new Map<string, number>();

  constructor(
    private readonly files: SandboxFiles,
    private readonly desktop: DesktopCapability,
  ) {
    super();
  }

  readonly effect: (args: ComputerAction) => ToolEffect = (args) =>
    READ_ACTIONS.has(args.action) ? 'read' : 'write_local';

  async run(args: ComputerAction, ctx: ToolContext): Promise<ToolOutput> {
    let ocr: string | undefined;
    let scale = this.screenshotScales.get(ctx.sessionId);
    if (needsCoordinates(args.action) && scale === undefined) {
      const state = await this.desktop.state(ctx.signal);
      scale = Math.min(1, DESKTOP_MAX_LONG_SIDE / Math.max(state.width, state.height));
    }
    scale ??= 1;
    switch (args.action) {
      case 'screenshot':
        break;
      case 'ocr': {
        const result = await this.desktop.ocr(
          { ...(args.region && { region: toDisplayRect(args.region as DesktopRect, scale) }) },
          ctx.signal,
        );
        ocr = result.text;
        break;
      }
      case 'wait':
        await wait(args.ms, ctx.signal);
        break;
      case 'move':
      case 'click':
      case 'double_click':
      case 'right_click':
      case 'drag':
      case 'scroll':
      case 'type':
      case 'key':
      case 'launch_app':
        await this.desktop.act(toDesktopAction(args, scale), ctx.signal);
        break;
    }

    const screenshot = await this.desktop.screenshot({}, ctx.signal);
    this.screenshotScales.set(ctx.sessionId, screenshot.scale);
    const shot = ++this.shots;
    const ref = `sessions/${ctx.sessionId}/images/computer-${ctx.turnId}-${shot}.png`;
    const name = `computer-${ctx.turnId}-${shot}.png`;
    await this.files.writeBytes(await this.files.resolve(ref), screenshot.data);

    const lines = [
      describeAction(args),
      `Screenshot ${screenshot.width}x${screenshot.height} px (scale ${screenshot.scale.toFixed(2)} from ${screenshot.originalWidth}x${screenshot.originalHeight}). Coordinates are in that screenshot; I mapped them to the display.`,
    ];
    if (ocr !== undefined) lines.push(`OCR text:\n${ocr.slice(0, 8_000)}`);
    return {
      content: lines.join('\n'),
      data: {
        action: args.action,
        screenshot: {
          ref,
          width: screenshot.width,
          height: screenshot.height,
          scale: screenshot.scale,
          originalWidth: screenshot.originalWidth,
          originalHeight: screenshot.originalHeight,
        },
      },
      images: [{ mediaType: 'image/png', ref, name }],
    };
  }
}

export function computerActTools(files: SandboxFiles, desktop: DesktopCapability): Tool[] {
  return [new ComputerActTool(files, desktop)];
}

function toDesktopAction(
  args: Exclude<ComputerAction, { action: 'screenshot' | 'wait' | 'ocr' }>,
  scale: number,
): DesktopAction {
  const map = (value: number) => Math.round(value / scale);
  switch (args.action) {
    case 'move':
      return { kind: 'move', x: map(args.x), y: map(args.y) };
    case 'click':
      return {
        kind: 'click',
        x: map(args.x),
        y: map(args.y),
        ...(args.button && { button: args.button }),
      };
    case 'double_click':
      return { kind: 'double_click', x: map(args.x), y: map(args.y) };
    case 'right_click':
      return { kind: 'right_click', x: map(args.x), y: map(args.y) };
    case 'drag':
      return {
        kind: 'drag',
        fromX: map(args.fromX),
        fromY: map(args.fromY),
        toX: map(args.toX),
        toY: map(args.toY),
        ...(args.button && { button: args.button }),
      };
    case 'scroll':
      return {
        kind: 'scroll',
        x: map(args.x),
        y: map(args.y),
        direction: args.direction,
        amount: args.amount,
      };
    case 'type':
      return { kind: 'type', text: args.text };
    case 'key':
      return { kind: 'key', key: args.key };
    case 'launch_app':
      return { kind: 'launch_app', app: args.app };
  }
}

const needsCoordinates = (action: ComputerAction['action']): boolean =>
  ['move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'ocr'].includes(action);

function toDisplayRect(rect: DesktopRect, scale: number): DesktopRect {
  const map = (value: number) => Math.round(value / scale);
  return {
    x: map(rect.x),
    y: map(rect.y),
    width: Math.max(1, map(rect.width)),
    height: Math.max(1, map(rect.height)),
  };
}

function describeAction(args: ComputerAction): string {
  switch (args.action) {
    case 'screenshot':
      return 'Took a screenshot.';
    case 'ocr':
      return 'Read the screen with OCR.';
    case 'wait':
      return `Waited ${args.ms} ms.`;
    case 'move':
      return `Moved the pointer to (${args.x}, ${args.y}).`;
    case 'click':
      return `Clicked ${args.button ?? 'left'} at (${args.x}, ${args.y}).`;
    case 'double_click':
      return `Double-clicked at (${args.x}, ${args.y}).`;
    case 'right_click':
      return `Right-clicked at (${args.x}, ${args.y}).`;
    case 'drag':
      return `Dragged from (${args.fromX}, ${args.fromY}) to (${args.toX}, ${args.toY}).`;
    case 'scroll':
      return `Scrolled ${args.direction} ${args.amount} at (${args.x}, ${args.y}).`;
    case 'type':
      return `Typed ${args.text.length} characters.`;
    case 'key':
      return `Pressed ${args.key}.`;
    case 'launch_app':
      return `Launched ${args.app}.`;
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Stopped'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Stopped'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
