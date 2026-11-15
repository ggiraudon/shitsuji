import { ProviderError } from '../../domain/errors.js';

/**
 * Turns a failed HTTP response into a ProviderError that names the provider and the real cause, and
 * says whether retrying makes sense (429 and 5xx, including Anthropic's 529 "overloaded").
 */
export async function httpError(provider: string, response: Response): Promise<ProviderError> {
  const raw = await response.text().catch(() => '');
  let detail = raw.slice(0, 500);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    const msg =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message);
    if (msg) detail = msg;
  } catch {
    // keep the raw text
  }
  const retryable = response.status === 429 || response.status >= 500;
  const retryAfter = Number(response.headers.get('retry-after'));
  return new ProviderError(
    provider,
    `${provider} returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: ${detail}`,
    retryable,
    {
      status: response.status,
      ...(Number.isFinite(retryAfter) && { retryAfterSeconds: retryAfter }),
    },
  );
}
