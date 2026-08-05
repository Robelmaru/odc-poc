import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { requireAuth } from "./auth/session.js";
import { pingDb } from "./db/database.js";
import { logger } from "./utils/logger.js";
import { ensureCrashTable, recordCrash, recentCrashes } from "./utils/crashLog.js";
import { getHealthStatus } from "./utils/health.js";
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
import { registerFrontend } from "./frontend.js";
import { loadEnvFile } from "./loadEnv.js";

loadEnvFile(".env");

const uploadMaxBytes = (Number(process.env.UPLOAD_MAX_MB) || 1024) * 1024 * 1024;

// Bumped per deploy so we can confirm (via /api/health) exactly which build a
// pod is serving — the rolling-update window otherwise makes this ambiguous.
const BUILD_MARKER = "ocr-buffer-copy-1";

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

// Report the container's real memory ceiling (the cgroup limit the kernel
// OOM-kills against) alongside current RSS, so we can confirm what limit a pod
// actually got — invaluable when a deployment's requested limit may not have
// scheduled. Returns megabytes; limitMb is null when uncapped/unreadable.
function memInfo(): { rssMb: number; heapUsedMb: number; limitMb: number | null } {
  let limitMb: number | null = null;
  for (const p of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const v = readFileSync(p, "utf8").trim();
      if (v === "max") break; // cgroup v2, uncapped
      const n = Number(v);
      // Ignore the "no limit" sentinel (a huge number close to 2^63).
      if (Number.isFinite(n) && n > 0 && n < 1e15) {
        limitMb = Math.round(n / (1024 * 1024));
      }
      break;
    } catch {
      /* try the next path */
    }
  }
  const m = process.memoryUsage();
  return {
    rssMb: Math.round(m.rss / (1024 * 1024)),
    heapUsedMb: Math.round(m.heapUsed / (1024 * 1024)),
    limitMb,
  };
}

// ── Health ──────────────────────────────────────────────────────────────────
// Liveness: "is the process up?" — no DB ping, no dependencies. The kubelet
// liveness probe targets this so a slow DB or a long CPU-bound request (OCR /
// multi-pass Claude) never gets the pod restarted out from under an in-flight
// upload. Restart the pod only when the process itself is wedged.
app.get("/api/health/live", async (_request, reply) => {
  return reply.code(200).send({ status: "ok", build: BUILD_MARKER });
});

// Recent crashes (uncaught exceptions / unhandled rejections), persisted across
// the restart that follows. Lets us diagnose a process crash without pod logs.
app.get("/api/health/crashes", async (_request, reply) => {
  return reply.code(200).send({ crashes: await recentCrashes(20) });
});

// Readiness/full health: "can this pod serve traffic?" — pings the DB and
// reports dependency status. The readiness probe targets this, so a pod with a
// broken DB is pulled from the Service (not killed).
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

  const health = getHealthStatus(checks);
  return reply.code(health.httpStatus).send({
    status: health.status,
    checks: health.checks,
    mem: memInfo(),
  });
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
await registerFrontend(app, fileURLToPath(new URL("../../frontend", import.meta.url)));

const port = Number(process.env.PORT) || 3000;

logger.info("ODC Complaint Analyzer (POC) starting", {
  url: `http://localhost:${port}`,
  env: process.env.NODE_ENV ?? "development",
  uploadMaxMb: Math.round(uploadMaxBytes / (1024 * 1024)),
  maxPdfPages: Math.max(0, Number(process.env.MAX_PDF_PAGES) || 5000),
});

// Best-effort: ensure the crash_log table exists so crash self-reporting works.
await ensureCrashTable().catch((e) =>
  logger.warn("Could not ensure crash_log table", { error: String(e) }),
);

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

// Surface otherwise-silent crashes (OPS-015). Log full stacks to stdout AND
// persist to the DB (crash_log) so the reason survives the restart and can be
// read from /api/health/crashes without pod-log access.
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", {
    reason: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  });
  void recordCrash("unhandledRejection", reason);
});
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception — exiting", {
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
  // Persist the crash, then exit (state is undefined after an uncaught throw).
  recordCrash("uncaughtException", err).finally(() => process.exit(1));
});
