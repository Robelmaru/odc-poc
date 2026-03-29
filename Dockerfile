FROM node:20-slim

WORKDIR /app

# Copy backend dependencies and install
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm install

# Copy source code
COPY backend/ ./backend/
COPY frontend/ ./frontend/

WORKDIR /app/backend

EXPOSE 3000

CMD ["node", "--env-file=.env", "--import=tsx", "src/index.ts"]
