import type { SessionId, TurnId } from '../domain/model/ids.js';
import type { FullViewerCredentials } from './SandboxDriver.js';

/** Who may drive the desktop now (S55). `owner` refuses the agent's writes, not its reads. */
export type DesktopControlMode = 'agent' | 'owner';

/** What the viewer and `/status` may show about the control mode. Never a password. */
export interface DesktopControlStatus {
  /** Who may drive now: `owner` refuses the agent's writes, but not its reads. */
  mode: DesktopControlMode;
  /** Who entered owner mode: the agent asked, or the owner pressed Take control. */
  requestedBy?: 'agent' | 'owner';
  /** The agent's stated reason, when it asked. */
  reason?: string;
  /** When owner mode began, ISO 8601. */
  since?: string;
  /** When an owner who never gives back is returned to the agent, ISO 8601. */
  expiresAt?: string;
  /** Where to watch or take control, when the deployment has a viewer. */
  viewerUrl?: string;
}

/** One agent request to take the desktop; the runner pauses the turn with the question. */
export interface AgentTakeoverRequest {
  /** The session whose turn asked; the question belongs to that session. */
  sessionId: SessionId;
  /** The turn that is asking, so the answer can find it. */
  turnId: TurnId;
  /** The agent's own words, shown to the owner labelled as unverified. */
  reason: string;
}

/** What the agent is told when it asks: refused, or the question the turn pauses on. */
export interface AgentTakeoverAnswer {
  /** False when the request was refused (no viewer, owner mode already, too soon). */
  ok: boolean;
  /** What the model is told. */
  message: string;
  /** The question the runner stores when it pauses the turn. */
  question?: string;
}

/** What the takeover tool needs from the control service. */
export interface TakeControlPort {
  /** The current mode; `agent` means the agent may write to the desktop. */
  readonly mode: DesktopControlMode;
  /** Asks the owner for the desktop and returns the refusal or the question. */
  requestByAgent(request: AgentTakeoverRequest): Promise<AgentTakeoverAnswer>;
  /** Called when the turn cannot pause: return the desktop to the agent instead of stranding it. */
  abandonAgentRequest(): void;
}

/** What the viewer needs: mode, take/give back, and the full password only in owner mode. */
export interface DesktopControlViewer {
  /** The current mode and its reason, for the viewer banner and `/status`. */
  status(): DesktopControlStatus;
  /** The owner takes control; refuses when there is no viewer or a takeover is in progress. */
  take(): Promise<DesktopControlStatus>;
  /** The owner hands the desktop back to the agent, ending owner mode. */
  giveBack(): Promise<DesktopControlStatus>;
  /** The full-control password; only valid in owner mode (S55). */
  fullCredentials(): Promise<FullViewerCredentials>;
  /** Calls `listener` on every mode change; returns the unsubscribe function. */
  onModeChange(listener: (mode: DesktopControlMode) => void): () => void;
}

/** The whole control surface: the tool's port plus the viewer's. */
export interface DesktopControl extends TakeControlPort, DesktopControlViewer {}
