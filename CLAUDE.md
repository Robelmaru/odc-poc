# Project Context — ODC Complaint Analyzer (POC)

A proof-of-concept document analyzer for the DC Bar **Office of Disciplinary Counsel (ODC)**.
It ingests complaint documents and discovery productions, runs Claude-backed analysis
(complaint analysis, Q&A over DC Bar rules, document timelines, records extraction,
translation + translation QA, AI-text detection, and discovery/production reconciliation),
and serves a single-page frontend.

> This file is read by the DC Bar review subagents before they start. Keep it accurate.

## Stack

- **Runtime**: Node.js 20 LTS (executed with `tsx`, no build/emit step).
- **Framework**: Hono (`hono` + `@hono/node-server`). *(Platform standard is Fastify — see deviations.)*
- **Language**: TypeScript 5, strict mode **on** (`backend/tsconfig.json`).
- **Database**: SQLite via `better-sqlite3`, file at `backend/data/odc-poc.db`. *(Platform standard is PostgreSQL + pgvector — see deviations. `pg` and `DATABASE_*` env vars are staged for that migration.)*
- **AI**: Anthropic SDK (`@anthropic-ai/sdk`) called directly (allowed by platform standard for direct SDK use). GPTZero used for AI-text detection with a Claude fallback.
- **Auth**: Microsoft Entra ID (Azure AD) SSO via `@azure/msal-node`, plus a legacy staff-PIN fallback.
- **OCR/PDF**: `tesseract.js` (OCR), `pdf-parse` + `pdf-poppler` (PDF text/image extraction).
- **Validation**: none formal yet (manual). *(Gap — see findings.)*
- **Testing**: Vitest (`--passWithNoTests` today; no suite yet — see findings).
- **Package manager**: npm. *(Platform standard is pnpm — see deviations.)*
- **Deployment target**: local Docker / `docker compose` only (no k8s/argocd yet).

## Repository layout

- `backend/src/index.ts` — Hono server entry; mounts all `/api/*` routes and serves the frontend.
- `backend/src/routes/` — one file per API surface (`analyze`, `qa`, `timeline`, `timeline-qa`, `records`, `translate`, `translation-qa`, `help-qa`, `ai-detect`, `auth`, `discovery`).
- `backend/src/db/` — SQLite access (e.g. `discovery.ts`).
- `backend/src/knowledge/` — domain knowledge encoded for the model (`dcRules.ts`, `subpoenaChecklist.ts`).
- `backend/src/skills/` — higher-level analysis units (`ProductionCompliance.ts`, `SectionIndex.ts`).
- `backend/src/utils/` — shared helpers (`pdfUtils.ts`, `duplicateDetector.ts`, `productionProcessor.ts`, `timelinePipeline.ts`, `logger.ts`).
- `backend/data/` — local SQLite DB + tessdata (gitignored — holds real case data, never commit).
- `frontend/` — static single-page UI (`index.html`) served by the backend.

## Architectural conventions

- All DB access goes through modules in `backend/src/db/`. Routes should not open the SQLite handle directly.
- All SQL uses `better-sqlite3` prepared statements with **bound parameters** — never string-concatenate user input into SQL.
- Long-running requests (OCR, multi-pass Claude comparisons) are expected; HTTP timeouts are disabled in `index.ts` on purpose.
- Use the structured logger in `backend/src/utils/logger.ts`; do not add `console.log` to committed code (the startup banner is the one allowed exception).

## Known intentional deviations

These diverge from the DC Bar platform standard **on purpose** because this is a POC. They are tracked for a future migration, not bugs to fix in passing:

- **Hono instead of Fastify.** No JSON-schema route validation / auto OpenAPI yet.
- **SQLite instead of PostgreSQL + pgvector.** No Drizzle, no migrations directory, no connection pooling/TLS.
- **npm instead of pnpm**, dependencies use `^` ranges rather than exact pins, Node not pinned via Volta.
- **No `deploy/k8s/` Kustomize tree and no `argocd/` Applications.** Deployment is local `docker compose` only.
- **No test suite yet** (Vitest is wired but empty).

## Out of scope for review

- `frontend/index.html` static markup styling.
- Vendored `backend/data/tessdata/` (Tesseract language data).
- The `ODC Logo*.png` assets and `Sample Cases/`.

## Review-specific notes

- Severity calibration: this is a **pre-production proof-of-concept** serving **internal ODC staff only**, but it handles **highly sensitive attorney-discipline case data and PII**. Treat any data-exposure, injection, or auth-bypass finding as elevated severity even though traffic is low.
- Compliance constraints: handles PII and confidential disciplinary records. No real case data may be committed to the repository or logged in full.
