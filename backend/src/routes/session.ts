import { Hono } from "hono";
import { getAuthUser, clearSession } from "../auth/session.js";

const session = new Hono();

// Who am I? Used by the frontend to confirm an active session on load.
// (Behind the global requireAuth middleware, so an unauthenticated caller
// gets a 401 before reaching this handler.)
session.get("/me", async (c) => {
  const user = await getAuthUser(c);
  if (!user) return c.json({ authenticated: false }, 401);
  return c.json({ authenticated: true, username: user.username, role: user.role });
});

session.post("/logout", async (c) => {
  await clearSession(c);
  return c.json({ success: true });
});

export default session;
