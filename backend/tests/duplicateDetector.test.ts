import { describe, it, expect } from "vitest";
import { findDuplicateBlocks, type FilePages } from "../src/utils/duplicateDetector.js";

// A block must exceed MIN_BLOCK_CHARS (120 normalized chars) to be considered.
// Use many DISTINCT words so the shingle set is large — then a one-token change
// keeps Jaccard well above the 0.82 NEAR threshold.
const LONG_A =
  "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november " +
  "oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu orange purple";
const LONG_B =
  "completely different invoice text about trust account ledgers and disbursement billing " +
  "statements for the client matter spanning several months of activity across accounts";

describe("findDuplicateBlocks (TEST-003)", () => {
  it("returns no matches for empty input", () => {
    const result = findDuplicateBlocks([]);
    expect(result.matches).toEqual([]);
    expect(result.blocksScanned).toBe(0);
  });

  it("ignores pages shorter than the minimum block size", () => {
    const files: FilePages[] = [
      { filename: "a.pdf", pages: [{ pageNum: 1, text: "too short" }] },
    ];
    const result = findDuplicateBlocks(files);
    expect(result.blocksScanned).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it("detects an EXACT duplicate within a single file", () => {
    const files: FilePages[] = [
      {
        filename: "a.pdf",
        pages: [
          { pageNum: 1, text: LONG_A },
          { pageNum: 2, text: LONG_A },
          { pageNum: 3, text: LONG_B },
        ],
      },
    ];
    const result = findDuplicateBlocks(files);
    const exact = result.matches.find((m) => m.type === "EXACT");
    expect(exact).toBeDefined();
    expect(exact!.similarity).toBe(1);
    expect(exact!.scope).toBe("within-file");
    expect(exact!.blocks).toHaveLength(2);
  });

  it("flags identical content across two files as cross-file", () => {
    const files: FilePages[] = [
      { filename: "a.pdf", pages: [{ pageNum: 1, text: LONG_A }] },
      { filename: "b.pdf", pages: [{ pageNum: 1, text: LONG_A }] },
    ];
    const result = findDuplicateBlocks(files);
    const exact = result.matches.find((m) => m.type === "EXACT");
    expect(exact).toBeDefined();
    expect(exact!.scope).toBe("cross-file");
  });

  it("detects a NEAR duplicate when one page is a slight variation of another", () => {
    const files: FilePages[] = [
      {
        filename: "a.pdf",
        pages: [
          { pageNum: 1, text: LONG_A + " extraone" },
          { pageNum: 2, text: LONG_A + " extratwo" },
        ],
      },
    ];
    const result = findDuplicateBlocks(files);
    const near = result.matches.find((m) => m.type === "NEAR");
    expect(near).toBeDefined();
    expect(near!.similarity).toBeGreaterThanOrEqual(0.82);
    expect(near!.blocks).toHaveLength(2);
  });
});
