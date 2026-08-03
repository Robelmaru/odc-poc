// HTTP-level integration tests for the discovery plugin's authorization + request
// validation (SEC-001 delete gate, TS-002 schema validation). Mounts the real
// plugin + requireAuth hook and drives it with app.inject() against the test
// Postgres. Sessions are created directly in the DB (no SSO/PIN needed here).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { randomBytes } from "node:crypto";
import discovery from "../src/routes/discovery.js";
import { requireAuth, SESSION_COOKIE } from "../src/auth/session.js";
import {
  createUser,
  getUserByUsername,
  updateUserActive,
  createSession,
} from "../src/db/database.js";
import { deleteCase } from "../src/db/discovery.js";

const OWNER = "vitest_disc_owner";
const OTHER = "vitest_disc_other";

async function sessionFor(username: string): Promise<string> {
  let u = await getUserByUsername(username);
  if (!u) {
    await createUser(username, "pw-" + username, "staff");
    u = await getUserByUsername(username);
  }
  await updateUserActive(u!.id, true);
  const token = randomBytes(24).toString("hex");
  await createSession(token, u!.username, u!.role, 12);
  return token;
}

let app: FastifyInstance;
let ownerCookie: string;
let otherCookie: string;
const createdCaseIds: number[] = [];

beforeAll(async () => {
  ownerCookie = await sessionFor(OWNER);
  otherCookie = await sessionFor(OTHER);
  app = Fastify();
  await app.register(cookie);
  app.addHook("onRequest", requireAuth);
  await app.register(discovery, { prefix: "/api/discovery" });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  for (const id of createdCaseIds) await deleteCase(id).catch(() => {});
  for (const name of [OWNER, OTHER]) {
    const u = await getUserByUsername(name);
    if (u) await updateUserActive(u.id, false);
  }
});

function inject(method: "GET" | "POST" | "DELETE", url: string, token: string, payload?: object) {
  return app.inject({ method, url, cookies: { [SESSION_COOKIE]: token }, payload });
}

describe("SEC-001 — case deletion is gated to creator/admin", () => {
  it("lets the creator delete their case but blocks another staff member (403)", async () => {
    const created = await inject("POST", "/api/discovery/cases", ownerCookie, { year: 2099 });
    expect(created.statusCode).toBe(200);
    const caseId = created.json().id as number;
    createdCaseIds.push(caseId);

    // A different staff member (not the creator, not admin) is forbidden.
    const forbidden = await inject("DELETE", `/api/discovery/cases/${caseId}`, otherCookie);
    expect(forbidden.statusCode).toBe(403);

    // The creator can delete it.
    const ok = await inject("DELETE", `/api/discovery/cases/${caseId}`, ownerCookie);
    expect(ok.statusCode).toBe(200);
    createdCaseIds.pop(); // deleted
  });

  it("requires authentication (401 without a session cookie)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/discovery/cases" });
    expect(res.statusCode).toBe(401);
  });
});

describe("TS-002 — request validation rejects bad input with 400", () => {
  it("rejects a non-integer :id param", async () => {
    const res = await inject("GET", "/api/discovery/cases/not-a-number", ownerCookie);
    expect(res.statusCode).toBe(400);
  });

  it("rejects a phase update with no `phase` field (required)", async () => {
    const created = await inject("POST", "/api/discovery/cases", ownerCookie, { year: 2099 });
    const caseId = created.json().id as number;
    createdCaseIds.push(caseId);
    const res = await inject("POST", `/api/discovery/cases/${caseId}/phase`, ownerCookie, {});
    expect(res.statusCode).toBe(400);
  });
});
