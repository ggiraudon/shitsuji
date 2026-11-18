import type {
  ActivityResponse,
  ApprovalResponse,
  ApprovalsResponse,
  LiveEvent,
  MessageDto,
  PairResponse,
  PostMessageResponse,
  SoulDto,
  TurnDto,
  UsageDto,
} from '@shitsuji/shared';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A client of the core HTTP API (S24), used by the TUI. Node 22's fetch and WebSocket are enough. */
export class ApiClient {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  async health(): Promise<boolean> {
    try {
      return (await this.fetchImpl(`${this.base}/api/health`)).ok;
    } catch {
      return false;
    }
  }

  send(content: string, sessionId?: string): Promise<PostMessageResponse> {
    return this.request('POST', '/api/messages', { content, sessionId });
  }

  history(
    sessionId = 'main',
    limit = 100,
  ): Promise<{ sessionId: string | null; messages: MessageDto[] }> {
    return this.request(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
    );
  }

  async newSession(): Promise<string> {
    return (await this.request<{ sessionId: string }>('POST', '/api/sessions')).sessionId;
  }

  turn(turnId: string): Promise<TurnDto> {
    return this.request('GET', `/api/turns/${encodeURIComponent(turnId)}`);
  }

  async stop(turnId: string): Promise<boolean> {
    return (
      await this.request<{ stopped: boolean }>(
        'POST',
        `/api/turns/${encodeURIComponent(turnId)}/stop`,
      )
    ).stopped;
  }

  /** The current SOUL and any edit of SOUL.md waiting to be confirmed (S23). */
  soul(): Promise<SoulDto> {
    return this.request('GET', '/api/soul');
  }

  /**
   * Confirms the reviewed edit of SOUL.md (its hash from soul()); it takes effect at the next turn.
   * Returns the new revision.
   */
  async applySoul(hash: string): Promise<number> {
    return (await this.request<{ revision: number }>('POST', '/api/soul/confirm', { hash }))
      .revision;
  }

  /** Spending so far, from the usage ledger (S29). */
  usage(): Promise<UsageDto> {
    return this.request('GET', '/api/usage');
  }

  /** Recent tool receipts, newest first (S29). */
  activity(limit = 10): Promise<ActivityResponse> {
    return this.request('GET', `/api/activity?limit=${limit}`);
  }

  /** A code that pairs a chat with you (S31). */
  pair(): Promise<PairResponse> {
    return this.request('POST', '/api/pair');
  }

  /** The cards waiting for you (S36). */
  approvals(): Promise<ApprovalsResponse> {
    return this.request('GET', '/api/approvals');
  }

  /** Answers a card; answering twice changes nothing the second time (S36). */
  resolveApproval(id: string, decision: 'approve' | 'decline'): Promise<ApprovalResponse> {
    return this.request('POST', `/api/approvals/${encodeURIComponent(id)}`, { decision });
  }

  /**
   * Opens the live-event stream. The owner key cannot go on a WebSocket, so it first gets a
   * single-use ticket over REST. Resolves once connected; call the returned function to close.
   */
  async events(onEvent: (event: LiveEvent) => void, onClose?: () => void): Promise<() => void> {
    const { ticket } = await this.request<{ ticket: string }>('POST', '/api/events/ticket');
    const url = `${this.base.replace(/^http/, 'ws')}/api/events?ticket=${encodeURIComponent(ticket)}`;
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new ApiError(0, `Cannot open ${url.split('?')[0]}`)),
        {
          once: true,
        },
      );
    });
    socket.addEventListener('message', (m) => {
      try {
        onEvent(JSON.parse(String(m.data)) as LiveEvent);
      } catch {
        // ignore frames that are not JSON
      }
    });
    socket.addEventListener('close', () => onClose?.());
    return () => socket.close();
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.key}`,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ApiError(0, `Cannot reach Shitsuji at ${this.base}: ${(error as Error).message}`);
    }
    const text = await response.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const message = (data as { error?: string } | undefined)?.error ?? `HTTP ${response.status}`;
      throw new ApiError(response.status, message);
    }
    return data as T;
  }
}
