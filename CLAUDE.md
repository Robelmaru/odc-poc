# Project Context — ODC Complaint Analyzer (POC)

A proof-of-concept document analyzer for the DC Bar **Office of Disciplinary Counsel (ODC)**.
It ingests complaint documents and discovery productions, runs Claude-backed analysis
(complaint analysis, Q&A over DC Bar rules, document timelines, records extraction,
translation + translation QA, AI-text detection, and discovery/production reconciliation),
and serves a single-page frontend.

> This file is read by the DC Bar review subagents before they start. Keep it accurate.

## Stack

- **Runtime**: Node.js 20 LTS (executed with `tsx`, no build/emit step), pinned via Volta.
- **Framework**: **Fastify 5** (routes are plugins; `@fastify/{cookie,cors,helmet,multipart,rate-limit,static,swagger,swagger-ui}`). JSON-schema validation on routes; OpenAPI served at `/api/docs`.
- **Language**: TypeScript 5, strict mode **on** (`backend/tsconfig.json`).
- **Database**: **PostgreSQL + pgvector** via a pooled `pg` client (`backend/src/db/client.ts`), connection from `DATABASE_URL`. **Drizzle** owns the schema (`backend/src/db/schema.ts`) and migrations (`backend/migrations/`); queries are parameterized raw SQL through the pool.
- **AI**: Anthropic SDK (`@anthropic-ai/sdk`) called directly (allowed by platform standard for direct SDK use); token usage logged. GPTZero used for AI-text detection with a Claude fallback.
- **Auth**: Microsoft Entra ID (Azure AD) SSO via `@azure/msal-node`, plus a legacy staff-PIN fallback. Server-side sessions (httpOnly cookie + `sessions` table).
- **OCR/PDF**: `tesseract.js` (OCR), `pdf-parse` + `pdf-poppler` (PDF text/image extraction).
- **Validation**: Zod for Claude JSON output (`backend/src/schemas/`); Fastify JSON-schema for request bodies.
- **Testing**: Vitest with `@vitest/coverage-v8`; integration tests run against a real Postgres (CI spins up a pgvector service).
- **Package manager**: **pnpm** (exact-pinned deps, `packageManager` + Volta pinned).
- **Deployment**: local `docker compose` for dev; **`deploy/k8s/`** (Kustomize base + staging/production overlays) reconciled by **Argo CD** (`argocd/`) for staging/prod. Multi-stage non-root Docker image pushed to GHCR by CI.

## Repository layout

- `backend/src/index.ts` — Fastify server entry; registers route plugins under `/api/*`, the auth hook, error handler, OpenAPI, and static frontend.
- `backend/src/routes/` — one Fastify plugin per API surface (`analyze`, `qa`, `timeline`, `timeline-qa`, `records`, `translate`, `translation-qa`, `help-qa`, `ai-detect`, `auth`, `discovery`, `session`).
- `backend/src/db/` — Postgres access: `client.ts` (pool + query helpers), `database.ts`, `discovery.ts`, `schema.ts` (Drizzle); migrations in `backend/migrations/`.
- `backend/src/auth/` — `session.ts` (cookie sessions + auth hook), `pin.ts` (scrypt). `backend/src/migrate.ts` — prod migration entrypoint.
- `backend/src/knowledge/` — domain knowledge encoded for the model (`dcRules.ts`, `subpoenaChecklist.ts`).
- `backend/src/skills/` — higher-level analysis units (`ProductionCompliance.ts`, `SectionIndex.ts`).
- `backend/src/utils/` — shared helpers (`pdfUtils.ts`, `duplicateDetector.ts`, `productionProcessor.ts`, `timelinePipeline.ts`, `logger.ts`).
- `backend/data/` — local SQLite DB + tessdata (gitignored — holds real case data, never commit).
- `frontend/` — static single-page UI (`index.html`) served by the backend.

## Architectural conventions

- All DB access goes through modules in `backend/src/db/` (`database.ts`, `discovery.ts`); the pooled client lives in `db/client.ts`. Routes never query the pool directly.
- All SQL uses **bound parameters** (the `?`→`$n` helper in `db/client.ts`) — never string-concatenate user input into SQL.
- Long-running requests (OCR, multi-pass Claude comparisons) are expected; the Fastify request timeout is disabled in `index.ts` on purpose.
- Use the structured logger in `backend/src/utils/logger.ts`; do not add `console.log` to committed code (the logger is the one sanctioned sink).

## Platform-standard conformance

The platform-stack deviations that were originally documented here have been resolved: **Fastify** (was Hono), **PostgreSQL + pgvector / Drizzle migrations** (was SQLite), **pnpm + exact-pinned deps + Volta** (was npm/`^`), **multi-stage non-root Docker + GHCR**, **`deploy/k8s` Kustomize + `argocd/`**, structured logging, and a **Vitest suite + CI coverage gate** (was none).

Remaining minor backlog (refinements, not platform deviations): JSON-bearing columns are still `text` and 0/1 flags `integer` (a faithful engine migration; `jsonb`/`boolean` + a `shared_with` junction table = DB-006 follow-up); Fastify route schemas cover request bodies + tags but not exhaustive response schemas; HTTP-route-level test coverage (TEST-013) is still thin.

## Out of scope for review

- `frontend/index.html` static markup styling.
- Vendored `backend/data/tessdata/` (Tesseract language data).
- The `ODC Logo*.png` assets and `Sample Cases/`.

## Review-specific notes

- Severity calibration: this is a **pre-production proof-of-concept** serving **internal ODC staff only**, but it handles **highly sensitive attorney-discipline case data and PII**. Treat any data-exposure, injection, or auth-bypass finding as elevated severity even though traffic is low.
- Compliance constraints: handles PII and confidential disciplinary records. No real case data may be committed to the repository or logged in full.
