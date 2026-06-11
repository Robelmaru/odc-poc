/**
 * Server-side session: an opaque random token in an httpOnly cookie, validated
 * against the `sessions` table. Trust anchor for the whole API (SEC-001/002).
 * The cookie holds only the token; identity/role/expiry come from the DB.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { createSession, getSessionUser, deleteSession } from "../db/database.js";

export const SESSION_COOKIE = "odc_session";
const SESSION_TTL_HOURS = 12;

export interface AuthUser {
  username: string;
  role: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

// /api/* paths reachable without a session. Everything else under /api/* is gated.
// (The Entra SSO routes live under /auth and are not covered by the gate.)
const PUBLIC_API_PATHS = new Set<string>(["/api/health", "/api/records/verify"]);

/** Create a session and set the httpOnly cookie on the reply. */
export async function issueSession(reply: FastifyReply, user: AuthUser): Promise<void> {
  const token = randomBytes(32).toString("hex");
  await createSession(token, user.username, user.role, SESSION_TTL_HOURS);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_HOURS * 60 * 60,
  });
}

/** Resolve the authenticated user from the cookie, re-checking the account is active. */
export async function getAuthUser(request: FastifyRequest): Promise<AuthUser | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  // DB-005: one JOIN instead of getSession + getUserByUsername.
  const row = await getSessionUser(token);
  if (!row || !row.active) return null;
  return { username: row.username, role: row.role };
}

/** Destroy the current session (server-side) and clear the cookie. */
export async function clearSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (token) await deleteSession(token);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

/**
 * Global onRequest hook: rejects any /api/* request without a valid session
 * (except the public login/health paths) and publishes `request.user`.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = request.url.split("?")[0]!;
  // Public: non-API paths, the login/health endpoints, and the OpenAPI docs UI.
  if (!path.startsWith("/api/") || PUBLIC_API_PATHS.has(path) || path.startsWith("/api/docs"))
    return;
  const user = await getAuthUser(request);
  if (!user) {
    await reply.code(401).send({ error: "Authentication required" });
    return;
  }
  request.user = user;
}

/** Read the authenticated user inside a protected handler (the hook guarantees it). */
export function authUser(request: FastifyRequest): AuthUser {
  return request.user!;
}
