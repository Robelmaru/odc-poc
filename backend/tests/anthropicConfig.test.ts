import { afterEach, describe, expect, it } from "vitest";
import { createAnthropicClient } from "../src/utils/anthropic.js";

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("createAnthropicClient", () => {
  it("creates a client when an API key is configured", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    const client = createAnthropicClient();

    expect(client).toBeDefined();
  });

  it("throws a clear error when the API key is missing", () => {
    expect(() => createAnthropicClient()).toThrow("ANTHROPIC_API_KEY is not configured.");
  });
});
