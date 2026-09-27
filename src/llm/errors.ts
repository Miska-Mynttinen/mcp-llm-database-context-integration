const RATE_LIMIT_MESSAGE = 'The AI service has reached its usage limit. Please try again later.';

/**
 * The LLM provider refused the request with HTTP 429 (its own rate limit or quota).
 * The message is safe to show users; `providerMessage` keeps the provider's wording for the logs.
 */
export class LLMRateLimitError extends Error {
  constructor(readonly providerMessage: string, readonly retryAfterSeconds?: number) {
    super(RATE_LIMIT_MESSAGE);
  }
}

/** Response headers as fetch gives them, or as a plain lower-cased record (the OpenAI SDK's form). */
export type ResponseHeaders = Headers | Readonly<Record<string, string | null | undefined>>;

/** Seconds from a numeric `Retry-After` header, or `undefined` when absent or not a number. */
export function retryAfterSeconds(headers: ResponseHeaders | undefined): number | undefined {
  const header = headers instanceof Headers ? headers.get('retry-after') : headers?.['retry-after'];
  const value = header?.trim() ? Number(header) : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined;
}
