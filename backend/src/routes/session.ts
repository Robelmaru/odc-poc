import { Hono } from "hono";
import { getAuthUser, clearSession } from "../auth/session.js";

const session = new Hono();

// Who am I? Used by the frontend to confirm an active session on load.
// (Behind the global requireAuth middleware, so an unauthenticated caller
// gets a 401 before reaching this handler.)
session.get("/me", (c) => {
  const user = getAuthUser(c);
  if (!user) return c.json({ authenticated: false }, 401);
  return c.json({ authenticated: true, username: user.username, role: user.role });
});

session.post("/logout", (c) => {
  clearSession(c);
  return c.json({ success: true });
});

export default session;
