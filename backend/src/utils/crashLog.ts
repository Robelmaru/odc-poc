// Crash self-reporting. When the process dies from an uncaught exception or an
// unhandled rejection, the in-memory job state is lost and there's no cluster
// access here to read pod logs — so persist the error to the DB and expose it
// via an endpoint we can curl. `currentPhase` tags what the pipeline was doing.
import { query, execute } from "../db/client.js";

let currentPhase = "idle";

/** Record what the processing pipeline is currently doing (tagged on any crash). */
export function setPhase(phase: string): void {
  currentPhase = phase;
}

let ensured = false;
export async function ensureCrashTable(): Promise<void> {
  await execute(
    `CREATE TABLE IF NOT EXISTS crash_log (
       id SERIAL PRIMARY KEY,
       at TIMESTAMPTZ NOT NULL DEFAULT now(),
       kind TEXT NOT NULL,
       phase TEXT,
       message TEXT,
       stack TEXT
     )`,
  );
  ensured = true;
}

/** Persist a crash. Best-effort — never throws (it runs while the process dies). */
export async function recordCrash(kind: string, err: unknown): Promise<void> {
  try {
    if (!ensured) await ensureCrashTable();
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? (err.stack ?? "") : "";
    await execute("INSERT INTO crash_log (kind, phase, message, stack) VALUES (?, ?, ?, ?)", [
      kind,
      currentPhase,
      message.slice(0, 4000),
      stack.slice(0, 12000),
    ]);
  } catch {
    /* best-effort; the process is already going down */
  }
}

/** Record a non-fatal diagnostic line (reuses the crash_log table as a sink). */
export async function recordDebug(kind: string, message: string): Promise<void> {
  try {
    if (!ensured) await ensureCrashTable();
    await execute("INSERT INTO crash_log (kind, phase, message, stack) VALUES (?, ?, ?, ?)", [
      kind,
      currentPhase,
      message.slice(0, 4000),
      "",
    ]);
  } catch {
    /* best-effort */
  }
}

/** Most recent crashes, newest first. */
export async function recentCrashes(limit = 20): Promise<unknown[]> {
  try {
    return await query(
      "SELECT id, at, kind, phase, message, stack FROM crash_log ORDER BY id DESC LIMIT ?",
      [limit],
    );
  } catch {
    return [];
  }
}
