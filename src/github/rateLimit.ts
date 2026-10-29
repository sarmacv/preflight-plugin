import type { RateLimit, RateLimitState } from '../shared/protocol';

/** Fraction of the hourly budget below which the strip shows the "low" state. */
export const LOW_FRACTION = 0.1;

export function readRateLimit(headers: Record<string, string | number | undefined>, waiting = false): RateLimit | undefined {
  const remaining = Number(headers['x-ratelimit-remaining']);
  const limit = Number(headers['x-ratelimit-limit']);
  const reset = Number(headers['x-ratelimit-reset']);
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) return undefined;
  let state: RateLimitState = remaining / limit < LOW_FRACTION ? 'low' : 'ok';
  if (waiting) state = 'waiting';
  return { state, remaining, limit, reset: Number.isFinite(reset) ? reset : 0 };
}
