import { logger } from "./logger.js";

/**
 * Parse a JSON string that came from a trusted-but-fallible source (e.g. a DB
 * TEXT column), returning `fallback` instead of throwing on malformed input
 * (finding DB-011 / TS-007). A single corrupted row should degrade one record,
 * not crash an entire list endpoint.
 */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    logger.warn("Failed to parse stored JSON; using fallback", {
      preview: raw.slice(0, 80),
    });
    return fallback;
  }
}
