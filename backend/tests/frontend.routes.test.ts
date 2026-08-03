import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerFrontend } from "../src/frontend.js";

const apps: Fastify.FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("frontend routing", () => {
  it("serves index.html for the site root", async () => {
    const root = await mkdtemp(join(tmpdir(), "odc-frontend-"));
    await writeFile(join(root, "index.html"), "<html><body>hello</body></html>");

    const app = Fastify();
    apps.push(app);
    await registerFrontend(app, root);

    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("hello");
  });

  it("falls back to index.html for unknown SPA routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "odc-frontend-"));
    await writeFile(join(root, "index.html"), "<html><body>spa shell</body></html>");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "assets", "main.js"), "console.log('asset');");

    const app = Fastify();
    apps.push(app);
    await registerFrontend(app, root);

    const res = await app.inject({ method: "GET", url: "/cases/123" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("spa shell");
  });
});
