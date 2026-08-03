---
description: Verify the repository still matches the DC Bar engineering standards (POC profile).
---

You are reviewing this repository for compliance with the DC Bar engineering standards. This is a **proof-of-concept** that intentionally deviates from some platform mandates (documented in `CLAUDE.md` → "Known intentional deviations"). Do not flag a documented deviation as BLOCKING — flag it as INFO and confirm it is still listed in `CLAUDE.md`.

## What to check

1. **TypeScript strictness** — `backend/tsconfig.json` includes `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`, `forceConsistentCasingInFileNames: true`, `target: ES2022`. No `// @ts-ignore` without an explanatory comment. No bare `any`.
2. **Lint / format** — `eslint.config.js` and `.prettierrc.json` exist; `package.json` exposes `lint`, `format`, `format:check`, `typecheck`, `test` scripts.
3. **Secrets** — `.env` is gitignored, `.env.example` exists and lists every variable used at runtime, no `.env` is `COPY`d into the Dockerfile, no PINs/keys hardcoded in committed files (`docker-compose.yml` should read from `${VAR}`, not literals).
4. **No data in the repo** — no `*.db`, no PDFs of real cases, no PII committed. `*.db` must be gitignored.
5. **Logging** — no `console.log` in committed `src/` code (the banner in `index.ts` and a dev logger are acceptable); use the structured logger in `src/utils/logger.ts`.
6. **Line endings** — `.gitattributes` enforces LF for `.sh`, `.yml`, `.yaml`, `Dockerfile*` and CRLF for `.ps1`, `.bat`, `.cmd`.
7. **CI** — `.github/workflows/ci.yml` runs install / typecheck / lint / format-check / test on PRs and pushes to `develop`, `staging`, `main` (runner `ubuntu-latest`). `.github/workflows/claude-review.yml` runs on every PR.
8. **Repo docs** — root `README.md` and `CLAUDE.md` exist and are current.
9. **Database access** — all SQL goes through parameterized statements (`better-sqlite3` prepared statements with bound params), never string-concatenated user input.
10. **Documented deviations** — `CLAUDE.md` still lists the known platform deviations (Hono vs Fastify, SQLite vs PostgreSQL+pgvector, npm vs pnpm, no k8s/argocd). Confirm they are present and have not silently grown.

## How to report

For each item, output one of:
- `OK — <one-line evidence>` (file path + what you saw)
- `BLOCKING — <what is wrong>` (file path + what to fix)
- `WARN — <what is suspicious>` (file path + why it might be a problem)
- `INFO — <documented deviation>` (confirm it is recorded in CLAUDE.md)

End with a one-line summary verdict.
