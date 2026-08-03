import { defineConfig } from "drizzle-kit";

// `db:migrate` needs a live DATABASE_URL. `db:generate` only reads the schema,
// so a placeholder is fine when generating migrations offline.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/odc_poc_dev",
  },
});
