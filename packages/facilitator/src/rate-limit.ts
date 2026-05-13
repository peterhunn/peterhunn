import type { Context, Next } from "hono";

export interface RateLimitOpts {
  /** Time window in milliseconds */
  windowMs: number;
  /** Max requests per IP within the window */
  max: number;
}

/**
 * Simple sliding-window rate limiter.
 *
 * Stores timestamps in-process. For multi-instance deployments, swap the
 * Map for a Redis-backed store. Sufficient for single-instance production.
 */
export function rateLimit(opts: RateLimitOpts) {
  const windows = new Map<string, number[]>();
  let lastEviction = Date.now();

  return async function rateLimitMiddleware(c: Context, next: Next): Promise<Response | void> {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "unknown";

    const now = Date.now();
    const cutoff = now - opts.windowMs;

    // Evict stale IPs every 60 s to prevent unbounded memory growth.
    if (now - lastEviction > 60_000) {
      for (const [key, ts] of windows) {
        if (ts[ts.length - 1]! < cutoff) windows.delete(key);
      }
      lastEviction = now;
    }

    const timestamps = (windows.get(ip) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= opts.max) {
      c.res = new Response(JSON.stringify({ error: "Too many requests" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil(opts.windowMs / 1000)),
          "X-RateLimit-Limit": String(opts.max),
          "X-RateLimit-Reset": String(Math.ceil((cutoff + opts.windowMs) / 1000)),
        },
      });
      return c.res;
    }

    timestamps.push(now);
    windows.set(ip, timestamps);
    await next();
  };
}
