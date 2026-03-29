import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import analyze from "./routes/analyze.js";
import qa from "./routes/qa.js";
import timeline from "./routes/timeline.js";
import timelineQA from "./routes/timeline-qa.js";
import records from "./routes/records.js";
import translate from "./routes/translate.js";

const app = new Hono();

// Enable CORS for local development
app.use("/*", cors());

// API routes
app.route("/api/analyze", analyze);
app.route("/api/qa", qa);
app.route("/api/timeline", timeline);
app.route("/api/timeline-qa", timelineQA);
app.route("/api/records", records);
app.route("/api/translate", translate);

// Health check
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Serve frontend
app.use("/*", serveStatic({ root: "../frontend" }));

// Fallback to index.html
app.get("/", (c) => c.redirect("/index.html"));

const port = Number(process.env.PORT) || 3000;

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ODC Complaint Analyzer - Proof of Concept (Node.js)     ║
║                                                           ║
║   Server running at: http://localhost:${port}               ║
║                                                           ║
║   Endpoints:                                              ║
║   - POST /api/analyze      - Analyze a complaint           ║
║   - POST /api/qa           - Q&A about rules              ║
║   - POST /api/timeline     - Document timeline            ║
║   - POST /api/timeline-qa  - Q&A about a timeline         ║
║   - GET  /api/health       - Health check                 ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`);

serve({
  fetch: app.fetch,
  port,
});
