import { describe, expect, it } from "vitest";
import { buildTextTranslationPrompt, buildTextTranslationRecord } from "../src/skills/Translate.js";

describe("buildTextTranslationPrompt", () => {
  it("includes the requested target language and source-language guidance", () => {
    const prompt = buildTextTranslationPrompt("Spanish", "English");

    expect(prompt).toContain("English");
    expect(prompt).toContain("Spanish");
    expect(prompt).toContain("Translate the provided text");
  });

  it("handles auto-detect mode without hard-coding a source language", () => {
    const prompt = buildTextTranslationPrompt("Auto-detect", "French");

    expect(prompt).toContain("French");
    expect(prompt).toContain("the source language");
  });

  it("builds a record payload that can be saved like document translations", () => {
    const record = buildTextTranslationRecord("English", "Hello there");

    expect(record.languageName).toBe("English");
    expect(record.results[0]?.filename).toBe("Typed text");
    expect(record.results[0]?.translation).toBe("Hello there");
  });
});
