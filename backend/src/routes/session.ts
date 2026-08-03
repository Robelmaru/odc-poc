import type { FastifyInstance } from "fastify";
import { getAuthUser, clearSession } from "../auth/session.js";

export default async function session(app: FastifyInstance) {
  // Who am I? Used by the frontend to confirm an active session on load.
  app.get("/me", { schema: { tags: ["session"] } }, async (request, reply) => {
    const user = await getAuthUser(request);
    if (!user) return reply.code(401).send({ authenticated: false });
    return { authenticated: true, username: user.username, role: user.role };
  });

  app.post("/logout", { schema: { tags: ["session"] } }, async (request, reply) => {
    await clearSession(request, reply);
    return { success: true };
  });
}
