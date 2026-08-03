import { describe, it, expect } from "vitest";
import { hashPin, isHashed, verifyPin } from "../src/auth/pin.js";

describe("pin hashing (SEC-005)", () => {
  it("hashes to the scrypt:salt:hash format and never stores the plaintext", () => {
    const stored = hashPin("1234");
    expect(stored.startsWith("scrypt:")).toBe(true);
    expect(stored.split(":")).toHaveLength(3);
    expect(stored).not.toContain("1234");
    expect(isHashed(stored)).toBe(true);
  });

  it("uses a random salt so equal PINs hash differently", () => {
    expect(hashPin("1234")).not.toBe(hashPin("1234"));
  });

  it("verifies a correct PIN against its hash", () => {
    expect(verifyPin("1234", hashPin("1234"))).toBe(true);
  });

  it("rejects an incorrect PIN", () => {
    expect(verifyPin("0000", hashPin("1234"))).toBe(false);
  });

  it("accepts a legacy plaintext value (pre-migration fallback)", () => {
    expect(isHashed("1234")).toBe(false);
    expect(verifyPin("1234", "1234")).toBe(true);
    expect(verifyPin("9999", "1234")).toBe(false);
  });

  it("rejects a malformed stored hash", () => {
    expect(verifyPin("1234", "scrypt:onlysalt")).toBe(false);
  });
});
