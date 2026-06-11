/**
 * Server-side session: an opaque random token in an httpOnly cookie, validated
 * against the `sessions` table on every request. This is the trust anchor for
 * the whole API — replacing the old pattern of trusting a `staff_id`/`admin_id`
 * string supplied in the request body (findings SEC-001 / SEC-002).
 *
 * The cookie holds only the random token. Identity, role, and expiry are read
 * from the database, so a forged or tampered cookie cannot grant access.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { createSession, getSession, deleteSession, getUserByUsername } from "../db/database.js";

export const SESSION_COOKIE = "odc_session";
const SESSION_TTL_HOURS = 12;

export interface AuthUser {
  username: string;
  role: string;
}

/**
 * Hono environment shared by authenticated routes. `requireAuth` populates
 * `user`, so handlers read the acting identity from `c.get("user")` rather
 * than trusting a `staff_id` supplied in the request (findings SEC-001).
 */
export type AppEnv = { Variables: { user: AuthUser; reqId: string } };

// Endpoints reachable without an authenticated session. Everything else under
// /api/* requires one. (The Entra SSO routes live under /auth and are not
// covered by the /api/* middleware.)
const PUBLIC_API_PATHS = new Set<string>(["/api/health", "/api/records/verify"]);

/** Create a session and set the httpOnly cookie on the response. */
export async function issueSession(c: Context, user: AuthUser): Promise<void> {
  const token = randomBytes(32).toString("hex");
  await createSession(token, user.username, user.role, SESSION_TTL_HOURS);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_HOURS * 60 * 60,
  });
}

/**
 * Resolve the authenticated user from the session cookie, or null. Re-checks
 * that the underlying account still exists and is active, so disabling a user
 * invalidates their session on the next request.
 */
export async function getAuthUser(c: Context): Promise<AuthUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = await getSession(token);
  if (!session) return null;
  const user = await getUserByUsername(session.username);
  if (!user || !user.active) return null;
  return { username: user.username, role: user.role };
}

/** Destroy the current session (server-side) and clear the cookie. */
export async function clearSession(c: Context): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await deleteSession(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/**
 * Global gate for /api/*: rejects any request without a valid session, and
 * publishes the authenticated user on the context for handlers to use.
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (PUBLIC_API_PATHS.has(c.req.path)) return next();
  const user = await getAuthUser(c);
  if (!user) return c.json({ error: "Authentication required" }, 401);
  c.set("user", user);
  return next();
};
