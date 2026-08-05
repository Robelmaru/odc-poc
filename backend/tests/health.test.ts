import { describe, expect, it } from "vitest";
import { getHealthStatus } from "../src/utils/health.js";

describe("getHealthStatus", () => {
  it("returns a degraded but healthy response when the database is up and Anthropic is not configured", () => {
    const result = getHealthStatus({ db: "ok", anthropic: "missing" });

    expect(result.status).toBe("degraded");
    expect(result.httpStatus).toBe(200);
    expect(result.checks.anthropic).toBe("missing");
  });

  it("returns an ok response when the database is up and Anthropic is configured", () => {
    const result = getHealthStatus({ db: "ok", anthropic: "ok" });

    expect(result.status).toBe("ok");
    expect(result.httpStatus).toBe(200);
    expect(result.checks.anthropic).toBe("ok");
  });

  it("returns a 503 response when the database is unreachable", () => {
    const result = getHealthStatus({ db: "error", anthropic: "missing" });

    expect(result.status).toBe("degraded");
    expect(result.httpStatus).toBe(503);
    expect(result.checks.db).toBe("error");
  });
});
