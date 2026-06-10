# syntax=docker/dockerfile:1
# Multi-stage build (OPS-005). Build tools live only in the builder; the runtime
# image carries just Node, the production node_modules (incl. the tsx runtime),
# poppler-utils, and the app source. Runs as a non-root user (OPS-006).

# ---- Builder: install production deps + compile the better-sqlite3 native addon ----
FROM node:20-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
# --omit=dev keeps eslint/vitest/prettier out of the image; tsx is a prod dep.
RUN npm ci --omit=dev

# ---- Runtime: slim image, only what is needed to run ----
FROM node:20-slim AS runtime
# poppler-utils is needed at runtime by pdf-poppler (PDF -> image for OCR).
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
COPY frontend /app/frontend

# Data dir (SQLite + tessdata) is a mounted volume at runtime; create + own it.
RUN mkdir -p /app/backend/data && chown -R odc:odc /app
USER odc

EXPOSE 3000

# Liveness/readiness probe (used by docker-compose and orchestrators).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import=tsx", "src/index.ts"]
