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

/** A failed API call: the HTTP status (0 when the server could not be reached) and the error text. */
export class ApiError extends Error {
  /** The class name, for logs and the TUI's error line. */
  override readonly name = 'ApiError';
  constructor(
    /** The HTTP status, or 0 when there was no response. */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A client of the core HTTP API (S24), used by the TUI. Node 22's fetch and WebSocket are enough. */
export class ApiClient {
  /** The base URL without a trailing slash; requests are appended to it. */
  private readonly base: string;

  constructor(
    /** Where core listens, e.g. `http://127.0.0.1:8787`. */
    baseUrl: string,
    /** The owner key, sent as a bearer token on every request. */
    private readonly key: string,
    /** The fetch implementation, injectable for tests. */
    private readonly fetchImpl: typeof fetch = fetch,
    /** The address the owner reaches core at, when it differs from the client's own base (Y2). */
    private readonly publicBaseUrl?: string,
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  /** True when the health endpoint answers; a network failure counts as unhealthy. */
  async health(): Promise<boolean> {
    try {
      return (await this.fetchImpl(`${this.base}/api/health`)).ok;
    } catch {
      return false;
    }
  }

  /** The watch-only desktop viewer (S51); the owner signs in there with the same key. */
  get desktopUrl(): string {
    return `${(this.publicBaseUrl ?? this.base).replace(/\/+$/, '')}/desktop`;
  }

  /** Stores an owner message and returns the turn that will answer it, without waiting. */
  send(content: string, sessionId?: string): Promise<PostMessageResponse> {
    return this.request('POST', '/api/messages', { content, sessionId });
  }

  /** The session's stored messages, oldest first, up to `limit` (the transcript the TUI draws). */
  history(
    sessionId = 'main',
    limit = 100,
  ): Promise<{
    /** The session that was read; null when it does not exist. */
    sessionId: string | null;
    /** The messages, already stripped of reasoning. */
    messages: MessageDto[];
  }> {
    return this.request(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
    );
  }

  /** Starts a fresh session in the owner's thread and returns its id, for `/new`. */
  async newSession(): Promise<string> {
    return (await this.request<{ sessionId: string }>('POST', '/api/sessions')).sessionId;
  }

  /** One turn's stored state, e.g. to show why it failed. */
  turn(turnId: string): Promise<TurnDto> {
    return this.request('GET', `/api/turns/${encodeURIComponent(turnId)}`);
  }

  /** Aborts a turn; false when it was already over or running in another process. */
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

  /** Sends one request and decodes the JSON; a non-2xx becomes an `ApiError`. */
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
