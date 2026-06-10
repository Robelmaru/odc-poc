/**
 * Minimal structured logger.
 *
 * DC Bar platform standard: structured logging (JSON in production), never raw
 * `console.log` in committed code, and **never log secrets or full PII payloads**.
 * In development we emit a readable line; in production we emit one JSON object
 * per line so logs are machine-parseable.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const isProduction = process.env.NODE_ENV === "production";

// `debug` is suppressed outside development to keep production logs clean.
const levelEnabled: Record<LogLevel, boolean> = {
  debug: !isProduction,
  info: true,
  warn: true,
  error: true,
};

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (!levelEnabled[level]) return;

  if (isProduction) {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...context,
    });
    // eslint-disable-next-line no-console -- the logger is the one sanctioned console sink
    (level === "error" || level === "warn" ? console.error : console.log)(line);
    return;
  }

  const suffix = context && Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  // eslint-disable-next-line no-console -- the logger is the one sanctioned console sink
  (level === "error" || level === "warn" ? console.error : console.log)(
    `[${level.toUpperCase()}] ${message}${suffix}`,
  );
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};
