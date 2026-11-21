import { z } from 'zod/v4';
import type { EventBus } from './EventBus.js';
import type { Logger } from './Logger.js';
import type { ToolSpec } from './ModelProvider.js';
import type { Transaction } from './Repositories.js';

/**
 * What a tool does, so the pipeline (and later the trust service, F11) can decide how careful to be.
 * Ordered from harmless to most consequential. The trust policy reads it per call (a tool may compute
 * its effect from its arguments), so it must describe the call, not the worst possible use of the tool.
 */
export type ToolEffect =
  | 'read' // reads state, changes nothing (search, read a file)
  | 'compute' // pure computation (calculator)
  | 'write_local' // changes the agent's own workspace or desktop
  | 'write_self' // changes Shitsuji's own state (memory, schedules, settings)
  | 'external' // acts on the outside world (send an email, post, submit a form)
  | 'payment'; // spends money

/** The effects as a runtime list, so code can iterate them; keep it in step with {@link ToolEffect}. */
export const TOOL_EFFECTS: readonly ToolEffect[] = [
  'read',
  'compute',
  'write_local',
  'write_self',
  'external',
  'payment',
];

/**
 * Where the tool runs. `core` is this process, `workspace` is the agent's sandbox, `desktop` is the GUI
 * in that sandbox and `mcp` an MCP server; the last two are declared for F10 and MCP tools, which do
 * not exist yet. The trust rules and receipts use it, so an action says where it happened.
 */
export type ToolTarget = 'core' | 'workspace' | 'desktop' | 'mcp';

/** How a tool call was allowed, for receipts and the activity log (F22, F11). */
export interface TrustBasis {
  /** `policy` is the fixed rule (S16), `rule` a standing rule, `quote` the owner's words (F11). */
  kind: 'policy' | 'rule' | 'quote' | 'owner' | 'none';
  /** The rule's id, the quoted words or the policy line, when there is one to show. */
  detail?: string;
}

/** What the trust policy decided about one call (F11, S34). */
export interface TrustDecision {
  /**
   * `allow`: run it. `ask`: the owner must approve it. `judge`: needs the model judge (S35).
   * `deny`: never run it.
   */
  verdict: 'allow' | 'ask' | 'judge' | 'deny';
  /** What allowed it (for the receipt); `none` when the call was not allowed. */
  basis: TrustBasis;
  /** Why it asks or is refused, in terms the owner and the model can read. */
  reason?: string;
  /** A judge may allow only with a verbatim quote of the owner's words (F11, S35). */
  quoteRequired?: boolean;
  /** The exact action, so a receipt or an approval names it (S34). */
  actionHash?: string;
  /** The approval this decision came from; the middleware reports how the run ended (S36). */
  approvalId?: string;
}

/**
 * What a running tool may use, and nothing else. There is no repository, no model and no config here:
 * a tool that needs the outside world uses its own adapter, injected when it was built.
 */
export interface ToolContext {
  /** The turn that made the call; the same id the events and receipts carry. */
  turnId: string;
  /** The session the turn belongs to. */
  sessionId: string;
  /** Aborted on Stop. Long-running tools must listen to it. */
  signal: AbortSignal;
  /** True when no owner message started this turn: waiting for an approval must be bounded. */
  background?: boolean;
  /** A logger bound with the tool's name, for the tool's own steps and failures. */
  log: Logger;
  /** The bus, for progress a UI can show while the tool runs. */
  events: EventBus;
  /** Runs fn in a transaction only while the turn is still running (TurnLock, F02). */
  writeFenced<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

/** An image a tool produced: a workspace file the ContextBuilder loads later. Never the bytes. */
export interface ToolImage {
  /** MIME type, e.g. `image/png`; the provider needs it to send the image. */
  mediaType: string;
  /** Workspace-relative path, e.g. `sessions/<id>/images/chart.png`. */
  ref: string;
  /** A name for the placeholder when the image is pruned from the context. */
  name?: string;
}

/** What a tool's run() returns. `content` is what the model sees. */
export interface ToolOutput {
  /** The result text the model reads; keep it short and say what happened. */
  content: string;
  /** The tool ran, but did not do what was asked (e.g. a command exited non-zero). */
  isError?: boolean;
  /** Structured result for receipts and UIs; not sent to the model. */
  data?: Record<string, unknown>;
  /** Images the model should see, by reference; never inline bytes. */
  images?: ToolImage[];
}

/**
 * The result of a call after the pipeline: what the model is told. An `error` names its reason so the
 * model can react (`invalid_input`, `denied`…) and the loop can stop on `repeated_failure`.
 */
export type ToolOutcome =
  | {
      /** The tool ran and returned a result. */
      kind: 'ok';
      /** What the model is told. */
      content: string;
      /** Structured data for receipts and files; not sent to the model. */
      data?: Record<string, unknown>;
      /** Images for the model to see, by reference; never inline bytes. */
      images?: ToolImage[];
    }
  | {
      /** The call did not produce a usable result. */
      kind: 'error';
      /** The class of failure, so the loop can react (e.g. stop on `repeated_failure`). */
      reason:
        | 'invalid_input'
        | 'not_found'
        | 'denied'
        | 'cancelled'
        | 'failed'
        | 'tool_error'
        | 'repeated_failure';
      /** What the model is told; names the cause in plain words. */
      content: string;
      /** Structured data for receipts; not sent to the model. */
      data?: Record<string, unknown>;
      /** Images the failed call still produced, when it produced any. */
      images?: ToolImage[];
    };

/**
 * One capability the model can call. The input schema is the contract: the model sees its JSON Schema
 * and the pipeline validates the arguments against it before `run`. `effect`, `target` and
 * `untrustedOutput` are what the trust and wrapping middlewares use, so they must be accurate.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a registry holds tools of any input type
export interface Tool<I = any> {
  /** Dotted, e.g. "workspace.exec". Adapters map dots for providers that refuse them. */
  readonly name: string;
  /** The call contract, short. */
  readonly description: string;
  /** Validates the model's arguments; its JSON Schema is what the model sees. */
  readonly input: z.ZodType;
  /** What it does, or a function of its arguments when that changes the answer. */
  readonly effect: ToolEffect | ((args: I) => ToolEffect);
  /** Where it runs; the trust rules and receipts use it to say where an action happened. */
  readonly target: ToolTarget;
  /** Hidden from the prompt until found with tool_search (F05). */
  readonly deferred: boolean;
  /** Output comes from outside (web, email, browser) and is wrapped as untrusted data. */
  readonly untrustedOutput: boolean;
  /** Runs the tool with validated arguments; return a `ToolOutput`, or throw for an unexpected bug. */
  run(args: I, ctx: ToolContext): Promise<ToolOutput>;
}

/**
 * Template for tools: sensible defaults; subclasses give name, description, input, effect and run.
 * `target` starts at `core`, so a tool runs in this process unless the subclass says otherwise.
 */
export abstract class BaseTool<S extends z.ZodType> implements Tool<z.infer<S>> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly input: S;
  abstract readonly effect: ToolEffect | ((args: z.infer<S>) => ToolEffect);
  /** Core by default; a subclass that runs in the sandbox overrides it. */
  readonly target: ToolTarget = 'core';
  readonly deferred: boolean = false;
  readonly untrustedOutput: boolean = false;
  /** Runs the tool with validated arguments; subclasses implement it. */
  abstract run(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

/** The effect of a call with these (already validated) arguments. */
export function effectOf<I>(tool: Tool<I>, args: I): ToolEffect {
  return typeof tool.effect === 'function' ? tool.effect(args) : tool.effect;
}

/** A file a tool asked to attach to the turn's reply (F06, S33). */
export interface OutboundFile {
  /** Absolute path on the core machine; the channel adapter reads it. */
  path: string;
  /** The file name the owner sees, including its extension. */
  name: string;
  /** MIME type, when known; channels use it to pick photo or document. */
  mediaType?: string;
  /** Text to show with the file. */
  caption?: string;
}

/**
 * The files a tool result asks to attach; an ordinary result has none. Entries missing a `path` or
 * `name` are dropped rather than failing the call, because the field comes from tool-provided
 * `data`, not from a schema.
 */
export function outboundFiles(outcome: ToolOutcome): OutboundFile[] {
  const files = outcome.data?.files;
  if (!Array.isArray(files)) return [];
  const parsed: OutboundFile[] = [];
  for (const raw of files) {
    if (!raw || typeof raw !== 'object') continue;
    const { path, name, mediaType, caption } = raw as Record<string, unknown>;
    if (typeof path !== 'string' || typeof name !== 'string') continue;
    parsed.push({
      path,
      name,
      ...(typeof mediaType === 'string' && { mediaType }),
      ...(typeof caption === 'string' && { caption }),
    });
  }
  return parsed;
}

/**
 * The tool as the model sees it: name, description and a JSON Schema of its arguments. The draft-7
 * schema is generated from the zod input in `io: 'input'` mode, so defaults and transforms are what the
 * model must send; `$schema` is dropped because providers reject it.
 */
export function toolSpec(tool: Tool): ToolSpec {
  const schema = z.toJSONSchema(tool.input, { target: 'draft-7', io: 'input' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return { name: tool.name, description: tool.description, parameters: schema };
}
