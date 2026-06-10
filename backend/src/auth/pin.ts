/**
 * PIN hashing for the legacy staff-PIN login (finding SEC-005). PINs must never
 * be stored or compared in cleartext. Uses Node's built-in scrypt — no extra
 * dependency — with a per-PIN random salt and a constant-time comparison.
 *
 * Stored format: `scrypt:<saltHex>:<hashHex>`.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const PREFIX = "scrypt";
const KEYLEN = 64;

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, KEYLEN);
  return `${PREFIX}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** True if the value is already a scrypt hash (vs. a legacy plaintext PIN). */
export function isHashed(stored: string): boolean {
  return stored.startsWith(`${PREFIX}:`);
}

export function verifyPin(pin: string, stored: string): boolean {
  // Defense in depth: a pre-migration plaintext value should still verify so a
  // deploy never locks anyone out. Startup migration rewrites these to hashes.
  if (!isHashed(stored)) {
    return stored === pin;
  }
  const [, saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(pin, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
