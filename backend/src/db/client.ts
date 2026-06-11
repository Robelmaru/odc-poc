// PostgreSQL connection + thin query helpers (SQLite → Postgres migration).
//
// The app uses parameterized raw SQL through a pooled `pg` connection (allowed by
// the DC Bar standard). Drizzle owns the schema + migrations (src/db/schema.ts).
// `toPg` lets the existing `?`-style SQL stay almost unchanged — placeholders are
// rewritten to Postgres `$1,$2,…`. None of our SQL contains a literal `?`.
import { Pool, type PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be set (postgres://user:pass@host:5432/db).");
}

export const pool = new Pool({
  connectionString,
  // Explicit pool size rather than the driver default (DB rule §Connections).
  max: Number(process.env.DATABASE_POOL_MAX) || 10,
  ssl: connectionString.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
});

function toPg(text: string): string {
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
}

/** Run a query, return all rows. */
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query(toPg(text), params as unknown[]);
  return res.rows as T[];
}

/** Run a query, return the first row (or undefined). */
export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const res = await pool.query(toPg(text), params as unknown[]);
  return res.rows[0] as T | undefined;
}

/** Run a write, return the affected row count. */
export async function execute(text: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query(toPg(text), params as unknown[]);
  return res.rowCount ?? 0;
}

export type TxQuery = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) => Promise<T[]>;

/** Run `fn` inside a transaction; commits on success, rolls back on throw. */
export async function withTransaction<T>(fn: (q: TxQuery) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const q: TxQuery = async (text, params = []) => {
      const res = await client.query(toPg(text), params as unknown[]);
      return res.rows as never[];
    };
    const result = await fn(q);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
