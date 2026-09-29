import { RateLimitError } from './errors.js';

const buckets = new Map();

/** Simple in-memory sliding window. Fine for one server; use a shared store if you ever run several. */
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(key, hits);
    throw new RateLimitError('Too many requests. Please wait a moment and try again.');
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 10000) {
    for (const [k, v] of buckets) if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
  }
}

export function resetRateLimits() { buckets.clear(); }
