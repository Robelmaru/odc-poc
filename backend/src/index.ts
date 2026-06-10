import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomUUID } from "node:crypto";
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
import { requireAuth, type AppEnv } from "./auth/session.js";
import { logger } from "./utils/logger.js";

const app = new Hono<AppEnv>();

// Security response headers — X-Content-Type-Options, X-Frame-Options, etc. (SEC-008)
app.use("/*", secureHeaders());

// CORS scoped to an explicit allowlist (SEC-008). The frontend is served
// same-origin and needs no CORS; set CORS_ORIGINS (comma-separated) only when a
// distinct origin must call the API. Credentials are on for the session cookie.
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use("/*", cors({ origin: corsOrigins, credentials: true }));

// Per-request access log with a correlation id (OPS-002).
app.use("/api/*", async (c, next) => {
  const reqId = randomUUID();
  c.set("reqId", reqId);
  const start = Date.now();
  await next();
  logger.info("request", {
    reqId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Date.now() - start,
  });
});

// Reject oversized uploads before buffering them into memory (SEC-006).
const uploadMaxMb = Number(process.env.UPLOAD_MAX_MB) || 200;
app.use(
  "/api/*",
  bodyLimit({
    maxSize: uploadMaxMb * 1024 * 1024,
    onError: (c) => c.json({ error: `Request body exceeds the ${uploadMaxMb} MB limit` }, 413),
  }),
);

// Authentication gate: every /api/* route requires a valid session cookie,
// except the public login/health paths handled inside requireAuth.
// (Mounted before the API routes so it runs first.)
app.use("/api/*", requireAuth);

// API routes
app.route("/api/session", session);
app.route("/api/analyze", analyze);
app.route("/api/qa", qa);
app.route("/api/timeline", timeline);
app.route("/api/timeline-qa", timelineQA);
app.route("/api/records", records);
app.route("/api/translate", translate);
app.route("/api/translation-qa", translationQA);
app.route("/api/help-qa", helpQA);
app.route("/api/ai-detect", aiDetect);
app.route("/api/discovery", discovery);
app.route("/auth", auth);

// Health check
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Serve frontend
app.use("/*", serveStatic({ root: "../frontend" }));

// Fallback to index.html
app.get("/", (c) => c.redirect("/index.html"));

// Consistent JSON shape for any unhandled route error (finding TS-015), instead
// of Hono's default plaintext 500. Never leak internal error detail to clients.
app.onError((err, c) => {
  logger.error("Unhandled route error", {
    path: c.req.path,
    method: c.req.method,
    error: err instanceof Error ? err.message : String(err),
  });
  return c.json({ error: "Internal server error" }, 500);
});

const port = Number(process.env.PORT) || 3000;

logger.info("ODC Complaint Analyzer (POC) starting", {
  url: `http://localhost:${port}`,
  env: process.env.NODE_ENV ?? "development",
});

const server = serve({
  fetch: app.fetch,
  port,
});

// Allow long-running requests (large OCR / multi-pass comparisons) — Node's
// default 5-minute requestTimeout would otherwise drop them as "Failed to fetch".
const httpServer = server as unknown as {
  requestTimeout?: number;
  headersTimeout?: number;
  timeout?: number;
};
httpServer.requestTimeout = 0; // no limit on time to receive a request
httpServer.headersTimeout = 0;
httpServer.timeout = 0; // no socket inactivity timeout
