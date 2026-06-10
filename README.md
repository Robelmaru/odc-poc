# ODC Complaint Analyzer (Proof of Concept)

A document analyzer for the DC Bar **Office of Disciplinary Counsel (ODC)**. It ingests
complaint documents and discovery productions and runs Claude-backed analysis:

- **Complaint analysis** against the DC Rules of Professional Conduct
- **Q&A** over DC Bar rules and over an uploaded document timeline
- **Document timelines** and **records extraction**
- **Translation** with a translation-QA pass
- **AI-text detection** (GPTZero with a Claude fallback)
- **Discovery / production reconciliation** (compliance against a subpoena checklist, duplicate detection)

A static single-page frontend is served by the backend.

> **Status:** proof of concept. It intentionally deviates from the DC Bar platform
> standard in several ways (Hono instead of Fastify, SQLite instead of PostgreSQL +
> pgvector, npm instead of pnpm, no Kubernetes/Argo CD). See
> [`CLAUDE.md`](CLAUDE.md) → *Known intentional deviations*.

## Architecture

```
odc-poc/
├── backend/            # Hono (Node 20 + tsx) API + static file server
│   ├── src/
│   │   ├── index.ts    # server entry, mounts /api/* routes
│   │   ├── routes/     # one file per API surface
│   │   ├── db/         # SQLite (better-sqlite3) access
│   │   ├── knowledge/  # DC rules + subpoena checklist encoded for the model
│   │   ├── skills/     # higher-level analysis units
│   │   └── utils/      # OCR/PDF helpers, logger, reconciliation pipeline
│   └── data/           # local SQLite DB + tessdata (gitignored)
└── frontend/           # static single-page UI
```

## Prerequisites

- **Node.js 20 LTS**
- **poppler-utils** (for `pdf-poppler` PDF→image conversion) — bundled in the Docker image; install locally if running outside Docker
- An **Anthropic API key**

## Local setup

```bash
cd backend
npm install
cp .env.example .env      # then fill in real values — .env is gitignored
npm run dev               # auto-reload; or `npm start`
```

The server listens on `http://localhost:3000` (override with `PORT`). The frontend is
served at `/` and the API under `/api/*`; health check at `/api/health`.

### Environment

All configuration is read from `backend/.env`. Every variable is documented in
[`backend/.env.example`](backend/.env.example). **Never commit `.env` or any real case
data / `*.db` file.**

## Quality checks

Run these before pushing (CI runs them too):

```bash
cd backend
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format:check  # prettier --check
npm test              # vitest
```

## Database migration (SQLite → PostgreSQL + pgvector)

The app currently runs on SQLite (`better-sqlite3`). Migration to the DC Bar
platform standard — **PostgreSQL 16 + pgvector 0.7+** — is in progress. The
Drizzle schema (`backend/src/db/schema.ts`) and generated migrations
(`backend/migrations/`) are in place; the runtime driver cutover is staged.

Local Postgres setup (matching staging/prod major version):

1. Install **PostgreSQL 16** and the **pgvector** extension.
2. `createdb odc_poc_dev`
3. Set `DATABASE_URL` in `backend/.env` (see `.env.example`).
4. Apply migrations: `cd backend && npm run db:migrate`
   (the first migration enables the `vector` extension).
5. Regenerate after schema changes: `npm run db:generate` (review the SQL, then `db:migrate`).

Staging/production use a dedicated Postgres server with `?sslmode=require`;
migrations run as a one-shot step before the app starts.

## Docker

```bash
# from the repo root, with ANTHROPIC_API_KEY and PIN_* exported (or in .env)
docker compose up
```

`docker-compose.yml` is for **local development only**.

## Git workflow

This repo follows the DC Bar three-branch model: push to `develop` directly; promote
`develop → staging → main` via pull request. Every PR runs CI and a Claude Code review
(see `.github/workflows/`). See the DC Bar engineering standards for full detail.
