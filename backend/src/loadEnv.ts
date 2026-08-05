import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvFile(filePath = ".env"): void {
  const fullPath = resolve(filePath);
  try {
    const contents = readFileSync(fullPath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore missing env files; the process may provide values directly.
  }
}
