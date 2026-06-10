import { describe, it, expect } from "vitest";
import { normalize, keyWords, wordOverlap, isSimilar } from "../src/utils/textSimilarity.js";

describe("textSimilarity (ARCH-006)", () => {
  it("normalize lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalize("  Hello,  WORLD!! \n")).toBe("hello world");
  });

  it("keyWords drops stop-words and short tokens", () => {
    const kw = keyWords("The attorney was retained by the client");
    expect(kw.has("attorney")).toBe(true);
    expect(kw.has("retained")).toBe(true);
    expect(kw.has("client")).toBe(true);
    expect(kw.has("the")).toBe(false); // stop word
    expect(kw.has("was")).toBe(false); // stop word
    expect(kw.has("by")).toBe(false); // short + stop word
  });

  it("wordOverlap is 1 for identical key-word sets and 0 when one side is empty", () => {
    expect(wordOverlap("attorney retained client", "client retained attorney")).toBe(1);
    expect(wordOverlap("the a of", "attorney")).toBe(0); // first side has no key words
  });

  it("isSimilar treats exact-normalized text as similar", () => {
    expect(isSimilar("Filed the Motion.", "filed the motion")).toBe(true);
  });

  it("isSimilar treats high word-overlap phrasings as the same event", () => {
    expect(
      isSimilar(
        "Attorney filed a motion to dismiss in Superior Court",
        "A motion to dismiss was filed by the attorney in Superior Court",
      ),
    ).toBe(true);
  });

  it("isSimilar returns false for unrelated text", () => {
    expect(isSimilar("Client paid the retainer fee", "Bank statement for March 2024")).toBe(false);
  });
});
