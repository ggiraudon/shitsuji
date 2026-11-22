import type { SessionId, TurnId } from '../domain/model/ids.js';
import type { FullViewerCredentials } from './SandboxDriver.js';

/** Who may drive the desktop now (S55). `owner` refuses the agent's writes, not its reads. */
export type DesktopControlMode = 'agent' | 'owner';

/** What the viewer and `/status` may show about the control mode. Never a password. */
export interface DesktopControlStatus {
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
  sessionId: SessionId;
  turnId: TurnId;
  /** The agent's own words, shown to the owner labelled as unverified. */
  reason: string;
}

export interface AgentTakeoverAnswer {
  ok: boolean;
  /** What the model is told. */
  message: string;
  /** The question the runner stores when it pauses the turn. */
  question?: string;
}

/** What the takeover tool needs from the control service. */
export interface TakeControlPort {
  readonly mode: DesktopControlMode;
  requestByAgent(request: AgentTakeoverRequest): Promise<AgentTakeoverAnswer>;
  /** Called when the turn cannot pause: return the desktop to the agent instead of stranding it. */
  abandonAgentRequest(): void;
}

/** What the viewer needs: mode, take/give back, and the full password only in owner mode. */
export interface DesktopControlViewer {
  status(): DesktopControlStatus;
  take(): Promise<DesktopControlStatus>;
  giveBack(): Promise<DesktopControlStatus>;
  fullCredentials(): Promise<FullViewerCredentials>;
  onModeChange(listener: (mode: DesktopControlMode) => void): () => void;
}

/** The whole control surface: the tool's port plus the viewer's. */
export interface DesktopControl extends TakeControlPort, DesktopControlViewer {}
