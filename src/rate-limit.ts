export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

type Counter = { count: number; resetAt: number };

export function createRateLimiter(windowMs: number, maxRequests: number) {
  const counters = new Map<string, Counter>();

  return (key: string, now = Date.now()): RateLimitResult => {
    const existing = counters.get(key);
    const counter = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + windowMs };

    counter.count += 1;
    counters.set(key, counter);

    // Avoid retaining inactive client keys forever in this in-memory limiter.
    if (counters.size > 1000) {
      for (const [storedKey, storedCounter] of counters) {
        if (storedCounter.resetAt <= now) counters.delete(storedKey);
      }
    }

    const allowed = counter.count <= maxRequests;
    return {
      allowed,
      remaining: Math.max(0, maxRequests - counter.count),
      retryAfterSeconds: Math.max(1, Math.ceil((counter.resetAt - now) / 1000))
    };
  };
}
