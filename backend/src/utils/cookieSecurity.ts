import type { FastifyRequest } from "fastify";

export function shouldUseSecureCookie(request: Pick<FastifyRequest, "headers" | "protocol">): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded || request.protocol || "http")
    .toString()
    .split(",")[0] ?? "http";
  const host = (request.headers.host || "").split(":")[0] ?? "";
  const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "::1";

  return process.env.NODE_ENV === "production" && proto === "https" && !isLocalhost;
}
