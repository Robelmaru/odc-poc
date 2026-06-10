/**
 * Minimal in-memory fixed-window rate limiter (finding SEC-014). Used to throttle
 * the PIN login endpoint against brute force. In-process only — adequate for the
 * single-instance POC; a shared store (Redis) would be needed if scaled out.
 */
import type { MiddlewareHandler } from "hono";
import { logger } from "../utils/logger.js";

interface Bucket {
  count: number;
  resetAt: number;
}

function clientIp(forwarded: string | undefined, real: string | undefined): string {
  return forwarded?.split(",")[0]?.trim() || real || "unknown";
}

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  name: string;
}): MiddlewareHandler {
  const hits = new Map<string, Bucket>();
  return async (c, next) => {
    const now = Date.now();
    const key = clientIp(c.req.header("x-forwarded-for"), c.req.header("x-real-ip"));

    let bucket = hits.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, bucket);
    }
    bucket.count++;

    // Opportunistic cleanup of expired buckets so the map can't grow unbounded.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    }

    if (bucket.count > opts.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      logger.warn("rate_limit_exceeded", { limiter: opts.name, ip: key, retryAfter });
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many attempts. Please try again later." }, 429);
    }
    return next();
  };
}
