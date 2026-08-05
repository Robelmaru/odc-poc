export type HealthStatus = {
  status: "ok" | "degraded";
  httpStatus: 200 | 503;
  checks: {
    db: "ok" | "error";
    anthropic: "ok" | "missing";
  };
};

export function getHealthStatus(checks: HealthStatus["checks"]): HealthStatus {
  const dbReady = checks.db === "ok";
  const isFullyReady = dbReady && checks.anthropic === "ok";

  return {
    status: isFullyReady ? "ok" : "degraded",
    httpStatus: dbReady ? 200 : 503,
    checks,
  };
}
