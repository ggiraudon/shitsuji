import type { SessionId, TurnId } from '../../domain/model/ids.js';
import type { Money } from '../../domain/model/Money.js';
import type { ModelProvider, ModelRequest, ModelStreamEvent } from '../../ports/ModelProvider.js';
import type { ModelCatalog } from '../models/ModelCatalog.js';
import type { BudgetService } from './BudgetService.js';
import { estimateRequestCost } from './estimate.js';

export interface BudgetedProviderOptions {
  budget: BudgetService;
  catalog: ModelCatalog;
}

/**
 * Puts every model request to the budget before it is sent (F22, S27): a conservative hold is taken
 * up front, then settled with the real cost from the usage event. If the request fails, is stopped or
 * is abandoned, the hold is released. A refusal happens before the inner provider is called.
 *
 * It sits outside `MeteredModelProvider`, whose usage row is written on `done` before the hold is
 * settled, so the ledger never double-counts a request.
 */
export class BudgetedModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly options: BudgetedProviderOptions,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  listModels(signal?: AbortSignal): Promise<string[]> {
    return this.inner.listModels(signal);
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    const ref = `${this.id}/${request.model}`;
    const meta = request.metadata ?? {};
    const reservation = await this.options.budget.reserve(
      {
        background: meta.background === true,
        ...(meta.sessionId && { sessionId: meta.sessionId as SessionId }),
        ...(meta.turnId && { turnId: meta.turnId as TurnId }),
      },
      estimateRequestCost(this.options.catalog, ref, request),
    );

    let settled = false;
    let actual: Money | undefined;
    try {
      for await (const event of this.inner.stream(request, signal)) {
        if (event.type === 'usage') actual = this.options.catalog.cost(ref, event.usage);
        if (event.type === 'done') {
          await this.options.budget.settle(reservation, actual);
          settled = true;
        }
        yield event;
      }
    } finally {
      // Failed, stopped or abandoned before the end: the ledger never saw the cost, so release it.
      if (!settled) await this.options.budget.release(reservation);
    }
  }
}
