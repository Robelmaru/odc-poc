# syntax=docker/dockerfile:1
# Multi-stage build (OPS-005). The runtime image carries just Node, the
# production node_modules (incl. the tsx runtime), poppler-utils, and the app
# source. Runs as a non-root user (OPS-006). No native modules remain after the
# Postgres migration (pg/tesseract.js/pdf-* are pure JS), so no compiler toolchain.

# ---- Builder: install production deps (pnpm) ----
FROM node:20-slim AS builder
WORKDIR /app/backend
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY backend/package.json backend/pnpm-lock.yaml backend/.npmrc ./
# --prod keeps eslint/vitest/prettier/drizzle-kit out of the image; tsx is a prod dep.
RUN pnpm install --prod --frozen-lockfile

# ---- Runtime: slim image, only what is needed to run ----
FROM node:20-slim AS runtime
# poppler-utils provides pdftoppm, invoked directly to render PDF pages to images for OCR.
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system odc && useradd --system --gid odc --create-home odc

WORKDIR /app/backend
ENV NODE_ENV=production

COPY --from=builder /app/backend/node_modules ./node_modules
COPY backend/package.json ./
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/migrations ./migrations
COPY frontend /app/frontend

# Vendored Tesseract OCR language model — required to OCR scanned PDFs. Without it
# the OCR worker throws ENOENT asynchronously and crashes the process, so it must
# be baked into the image (it is NOT a runtime-mounted volume).
COPY backend/data/tessdata /app/backend/data/tessdata

# The database is PostgreSQL on a dedicated server (DATABASE_URL), not a local file.
RUN mkdir -p /app/backend/data && chown -R odc:odc /app
USER odc

EXPOSE 3000

# Liveness/readiness probe (used by docker-compose and orchestrators).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import=tsx", "src/index.ts"]
