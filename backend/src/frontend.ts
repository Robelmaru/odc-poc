import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

export async function registerFrontend(app: FastifyInstance, rootDir: string) {
  await app.register(fastifyStatic, {
    root: rootDir,
    prefix: "/",
    index: "index.html",
    wildcard: false,
  });

  app.setNotFoundHandler(async (_request, reply) => {
    const indexPath = join(rootDir, "index.html");
    try {
      await stat(indexPath);
      return reply.type("text/html").sendFile("index.html", rootDir);
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
  });
}
