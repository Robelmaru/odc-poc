FROM node:20-slim

# Install poppler-utils (needed by pdf-poppler for PDF-to-image conversion)
# and build tools (needed by better-sqlite3 native module)
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy backend dependencies and install
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm install

# Copy source code
COPY backend/ ./backend/
COPY frontend/ ./frontend/

WORKDIR /app/backend

EXPOSE 3000

RUN mkdir -p /app/backend/data

CMD ["node", "--import=tsx", "src/index.ts"]
