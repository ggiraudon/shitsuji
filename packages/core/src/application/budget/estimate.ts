import type { ModelCatalog } from '../models/ModelCatalog.js';
import type { ModelRequest } from '../../ports/ModelProvider.js';
import type { Money } from '../../domain/model/Money.js';

/** Characters per token assumed when estimating: deliberately low, so the estimate is generous. */
const CHARACTERS_PER_TOKEN = 3;

/**
 * A conservative maximum for one model request: every character of the prompt and tool schemas at
 * three characters per token, plus the output the request allows. The usage row replaces it with the
 * real cost once the request completes (F22, S27).
 */
export function estimateRequestCost(
  catalog: ModelCatalog,
  ref: string,
  request: ModelRequest,
): Money | undefined {
  const info = catalog.get(ref);
  if (!info?.price) return undefined;
  const inputTokens = Math.ceil(promptCharacters(request) / CHARACTERS_PER_TOKEN);
  const outputTokens = request.maxOutputTokens ?? info.maxOutput ?? 4096;
  return catalog.cost(ref, { inputTokens, outputTokens });
}

function promptCharacters(request: ModelRequest): number {
  let chars = request.system?.length ?? 0;
  for (const message of request.messages) {
    for (const part of message.parts) {
      if (part.type === 'text') chars += part.text.length;
      else if (part.type === 'tool_result') chars += part.content.length;
    }
  }
  if (request.tools?.length) chars += JSON.stringify(request.tools).length;
  return chars;
}
