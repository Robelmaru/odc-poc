import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests run against a dedicated Postgres test database (migrated
    // beforehand). Never point this at a real/dev database (TEST-007).
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgres://postgres:changeme@localhost:5432/odc_poc_test",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      // DC Bar standard is ≥70% on NEW code, not the whole legacy tree. We gate
      // per-file on the modules that currently have tests, and add an entry as
      // each new module gains coverage. This keeps the gate honest without
      // failing on the not-yet-tested POC surface.
      thresholds: {
        "src/auth/pin.ts": { lines: 90, functions: 100, statements: 90, branches: 70 },
        "src/auth/session.ts": { lines: 85, functions: 75, statements: 75, branches: 70 },
        "src/utils/duplicateDetector.ts": { lines: 70, functions: 70, statements: 70, branches: 55 },
        "src/knowledge/subpoenaChecklist.ts": { lines: 80, functions: 100, statements: 80, branches: 50 },
        "src/schemas/claudeResults.ts": { lines: 80, functions: 50, statements: 80, branches: 60 },
        "src/utils/textSimilarity.ts": { lines: 90, functions: 100, statements: 90, branches: 75 },
      },
    },
  },
});
