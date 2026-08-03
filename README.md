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

> **Status:** proof of concept, aligned with the DC Bar platform standard:
> Fastify, PostgreSQL + pgvector (Drizzle migrations), pnpm, multi-stage Docker,
> and `deploy/k8s` + Argo CD. See [`CLAUDE.md`](CLAUDE.md) → *Platform-standard conformance*.

## Architecture

```
odc-poc/
├── backend/            # Fastify (Node 20 + tsx) API + static file server
│   ├── src/
│   │   ├── index.ts    # Fastify entry: route plugins, auth hook, OpenAPI, static
│   │   ├── routes/     # one Fastify plugin per API surface
│   │   ├── db/         # Postgres: client (pool), database/discovery, schema (Drizzle)
│   │   ├── auth/        # cookie sessions + scrypt PINs
│   │   ├── knowledge/  # DC rules + subpoena checklist encoded for the model
│   │   ├── skills/     # higher-level analysis units
│   │   ├── schemas/    # Zod schemas for Claude output
│   │   └── utils/      # OCR/PDF helpers, logger, reconciliation pipeline
│   └── migrations/     # Drizzle SQL migrations
├── deploy/k8s/         # Kustomize base + staging/production overlays (Argo CD)
├── argocd/             # Argo CD Application manifests
└── frontend/           # static single-page UI
```

## Prerequisites

- **Node.js 20 LTS** and **pnpm 9** (`npm i -g pnpm` or via Volta/corepack)
- **PostgreSQL 16 + pgvector** (local for dev; dedicated server for staging/prod)
- **poppler-utils** (for `pdf-poppler` PDF→image conversion) — bundled in the Docker image; install locally if running outside Docker
- An **Anthropic API key**

## Local setup

```bash
cd backend
pnpm install
cp .env.example .env      # then fill in real values (incl. DATABASE_URL) — .env is gitignored
pnpm run db:migrate       # apply schema to your local Postgres (enables pgvector)
pnpm run dev              # auto-reload; or `pnpm start`
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
pnpm run typecheck     # tsc --noEmit
pnpm run lint          # eslint
pnpm run format:check  # prettier --check
pnpm test              # vitest
```

## Database (PostgreSQL 16 + pgvector)

1. Install **PostgreSQL 16** and the **pgvector** extension; `createdb odc_poc_dev`.
2. Set `DATABASE_URL` in `backend/.env` (see `.env.example`).
3. Apply migrations: `pnpm run db:migrate` (the first migration enables `vector`).
4. After editing `src/db/schema.ts`: `pnpm run db:generate` (review the SQL), then `db:migrate`.

Staging/production use a dedicated Postgres server with `?sslmode=require`; the
Argo CD PreSync Job runs `pnpm run migrate` (drizzle-orm migrator) before each rollout.

## Docker & deployment

```bash
# local: from the repo root, with ANTHROPIC_API_KEY, DATABASE_URL, PIN_* in .env
docker compose up
```

`docker-compose.yml` is for **local development only**. Staging and production run on
Kubernetes: CI builds a multi-stage image to GHCR, and **Argo CD** reconciles the
`deploy/k8s/overlays/<env>` Kustomize manifests (see [`deploy/k8s/README.md`](deploy/k8s/README.md)).

## Git workflow

This repo follows the DC Bar three-branch model: push to `develop` directly; promote
`develop → staging → main` via pull request. Every PR runs CI and a Claude Code review
(see `.github/workflows/`). See the DC Bar engineering standards for full detail.
