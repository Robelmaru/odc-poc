// HTTP-level integration tests for the records plugin's auth surface (TEST-013).
// Mounts the real route plugin + the production requireAuth hook on a throwaway
// Fastify instance and drives it with app.inject() — no mocks. Runs against the
// dedicated Postgres test DB (DATABASE_URL set in vitest.config.ts). Idempotent
// against a persistent DB: uses a fixed test user reset in beforeAll.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import records from "../src/routes/records.js";
import { requireAuth, SESSION_COOKIE } from "../src/auth/session.js";
import {
  createUser,
  getUserByUsername,
  updateUserPin,
  updateUserActive,
} from "../src/db/database.js";

const USERNAME = "vitest_verify_user";
const PASSWORD = "vitest-pw-123456";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(cookie);
  // Mirror production: the global gate runs before every route.
  app.addHook("onRequest", requireAuth);
  await app.register(records, { prefix: "/api/records" });
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeAll(async () => {
  const existing = await getUserByUsername(USERNAME);
  if (!existing) await createUser(USERNAME, PASSWORD, "staff");
  const u = (await getUserByUsername(USERNAME))!;
  await updateUserPin(u.id, PASSWORD);
  await updateUserActive(u.id, true);
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  // Leave the user disabled so a persistent test DB doesn't carry an active login.
  const u = await getUserByUsername(USERNAME);
  if (u) await updateUserActive(u.id, false);
});

describe("POST /api/records/verify (login)", () => {
  it("accepts correct credentials, returns role, and sets the session cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/records/verify",
      payload: { staff_id: USERNAME, pin: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.role).toBe("staff");
    expect(res.cookies.some((c) => c.name === SESSION_COOKIE && c.value.length > 0)).toBe(true);
  });

  it("rejects a wrong password with 401 and no cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/records/verify",
      payload: { staff_id: USERNAME, pin: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.cookies.some((c) => c.name === SESSION_COOKIE)).toBe(false);
  });

  it("rejects an unknown user with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/records/verify",
      payload: { staff_id: "no_such_user_xyz", pin: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a disabled account with 403", async () => {
    const u = (await getUserByUsername(USERNAME))!;
    await updateUserActive(u.id, false);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/records/verify",
        payload: { staff_id: USERNAME, pin: PASSWORD },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await updateUserActive(u.id, true);
    }
  });
});

describe("auth gate (requireAuth) on protected records routes", () => {
  it("returns 401 for an admin route with no session cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/api/records/admin/users" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for an admin route when logged in as a non-admin (staff)", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/records/verify",
      payload: { staff_id: USERNAME, pin: PASSWORD },
    });
    const token = login.cookies.find((c) => c.name === SESSION_COOKIE)!.value;

    const res = await app.inject({
      method: "GET",
      url: "/api/records/admin/users",
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("TS-002 — request-body validation on admin routes", () => {
  it("rejects /admin/users/toggle with no user_id (400, before the handler)", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/records/verify",
      payload: { staff_id: USERNAME, pin: PASSWORD },
    });
    const token = login.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
    const res = await app.inject({
      method: "POST",
      url: "/api/records/admin/users/toggle",
      cookies: { [SESSION_COOKIE]: token },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
