// Production migration entrypoint. The Argo CD PreSync Job (deploy/k8s/base/
// migrate-job.yaml) runs `node --import=tsx src/migrate.ts` against the same image
// as the app. Applies backend/migrations/ via the drizzle-orm migrator, which is a
// production dependency — `drizzle-kit` is dev-only and not in the runtime image.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { logger } from "./utils/logger.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must be set to run migrations.");

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
});

logger.info("Applying database migrations");
await migrate(drizzle(pool), { migrationsFolder: "migrations" });
logger.info("Migrations applied");
await pool.end();
