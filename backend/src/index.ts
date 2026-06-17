import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { fileURLToPath } from "node:url";
import { requireAuth } from "./auth/session.js";
import { pingDb } from "./db/database.js";
import { logger } from "./utils/logger.js";
import analyze from "./routes/analyze.js";
import qa from "./routes/qa.js";
import timeline from "./routes/timeline.js";
import timelineQA from "./routes/timeline-qa.js";
import records from "./routes/records.js";
import translate from "./routes/translate.js";
import translationQA from "./routes/translation-qa.js";
import helpQA from "./routes/help-qa.js";
import aiDetect from "./routes/ai-detect.js";
import auth from "./routes/auth.js";
import discovery from "./routes/discovery.js";
import session from "./routes/session.js";

const uploadMaxBytes = (Number(process.env.UPLOAD_MAX_MB) || 1024) * 1024 * 1024;

const app = Fastify({
  // Long OCR / multi-pass Claude requests are expected — no request timeout.
  requestTimeout: 0,
  connectionTimeout: 0,
  bodyLimit: uploadMaxBytes, // SEC-006: cap JSON bodies (multipart is capped separately)
  logger: false, // we use our own structured logger
});

// ── Plugins ─────────────────────────────────────────────────────────────────
// Security response headers (SEC-008). CSP left off by default (SEC-005 backlog).
await app.register(helmet, { contentSecurityPolicy: false });

// CORS scoped to an allowlist (SEC-008). Same-origin frontend needs none.
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
await app.register(cors, { origin: corsOrigins.length ? corsOrigins : false, credentials: true });

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: uploadMaxBytes } }); // SEC-006
await app.register(rateLimit, { global: false }); // enabled per-route (login — SEC-014)

// OpenAPI (api-contracts standard): generated from route schemas, served at /api/docs.
await app.register(swagger, {
  openapi: {
    info: { title: "ODC Complaint Analyzer API", version: "1.0.0" },
  },
});
await app.register(swaggerUi, { routePrefix: "/api/docs" });

// ── Hooks ─────────────────────────────────────────────────────────────────
// Authentication gate for /api/* (publishes request.user). Runs before handlers.
app.addHook("onRequest", requireAuth);

// Structured per-request access log with the built-in request id (OPS-002).
app.addHook("onResponse", async (request, reply) => {
  const path = request.url.split("?")[0]!;
  if (!path.startsWith("/api/")) return;
  logger.info("request", {
    reqId: request.id,
    method: request.method,
    path,
    status: reply.statusCode,
    ms: Math.round(reply.elapsedTime),
  });
});

// Consistent JSON error shape (TS-015 / fastify error-handling rule). Surfaces
// schema-validation failures as 400; never leaks internals on 500.
app.setErrorHandler((err: FastifyError, request, reply) => {
  if (err.validation) {
    return reply.code(400).send({ error: { code: "VALIDATION", message: err.message } });
  }
  const status = typeof err.statusCode === "number" && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) {
    logger.error("Unhandled route error", {
      reqId: request.id,
      path: request.url.split("?")[0],
      error: err instanceof Error ? err.message : String(err),
    });
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Internal server error" } });
  }
  return reply.code(status).send({ error: { code: "REQUEST", message: err.message } });
});

// ── Health ──────────────────────────────────────────────────────────────────
app.get("/api/health", async (_request, reply) => {
  const checks = {
    db: "ok" as "ok" | "error",
    anthropic: process.env.ANTHROPIC_API_KEY ? "ok" : "missing",
  };
  try {
    await pingDb();
  } catch {
    checks.db = "error";
  }
  const healthy = checks.db === "ok" && checks.anthropic === "ok";
  return reply.code(healthy ? 200 : 503).send({ status: healthy ? "ok" : "degraded", checks });
});

// ── API routes ───────────────────────────────────────────────────────────────
await app.register(session, { prefix: "/api/session" });
await app.register(analyze, { prefix: "/api/analyze" });
await app.register(qa, { prefix: "/api/qa" });
await app.register(timeline, { prefix: "/api/timeline" });
await app.register(timelineQA, { prefix: "/api/timeline-qa" });
await app.register(records, { prefix: "/api/records" });
await app.register(translate, { prefix: "/api/translate" });
await app.register(translationQA, { prefix: "/api/translation-qa" });
await app.register(helpQA, { prefix: "/api/help-qa" });
await app.register(aiDetect, { prefix: "/api/ai-detect" });
await app.register(discovery, { prefix: "/api/discovery" });
await app.register(auth, { prefix: "/auth" });

// ── Static frontend (registered last so explicit routes win) ─────────────────
await app.register(fastifyStatic, {
  root: fileURLToPath(new URL("../../frontend", import.meta.url)),
  prefix: "/",
});

const port = Number(process.env.PORT) || 3000;

logger.info("ODC Complaint Analyzer (POC) starting", {
  url: `http://localhost:${port}`,
  env: process.env.NODE_ENV ?? "development",
  uploadMaxMb: Math.round(uploadMaxBytes / (1024 * 1024)),
  maxPdfPages: Math.max(0, Number(process.env.MAX_PDF_PAGES) || 5000),
});

await app.listen({ port, host: "0.0.0.0" });

// Graceful shutdown (OPS-007): drain in-flight requests before exit.
function shutdown(signal: string) {
  logger.info("Shutdown signal received; draining in-flight requests", { signal });
  app
    .close()
    .then(() => {
      logger.info("HTTP server closed; exiting");
      process.exit(0);
    })
    .catch(() => process.exit(1));
  setTimeout(() => {
    logger.warn("Drain timeout reached; forcing exit");
    process.exit(0);
  }, 30_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Surface otherwise-silent crashes (OPS-015).
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason: String(reason) });
});
