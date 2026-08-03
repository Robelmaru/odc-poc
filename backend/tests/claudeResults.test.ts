import { describe, it, expect } from "vitest";
import {
  ProductionComplianceResultSchema,
  AnalysisResultSchema,
} from "../src/schemas/claudeResults.js";

describe("ProductionComplianceResultSchema (TS-001)", () => {
  it("accepts a well-formed result unchanged", () => {
    const input = {
      items: [
        {
          item_type: "bank_statements",
          label: "Monthly bank statements",
          status: "received",
          confidence: "HIGH",
          source_section_id: "sec-1",
          evidence: "pages 3-8",
          notes: "",
        },
      ],
      summary: "ok",
      missingCount: 0,
      rule115Flags: [],
      recommendedFollowUp: "",
    };
    const out = ProductionComplianceResultSchema.parse(input);
    expect(out.items[0]!.status).toBe("received");
  });

  it("coerces an invalid status to 'missing' (no corrupt DB write)", () => {
    const out = ProductionComplianceResultSchema.parse({
      items: [{ item_type: "x", status: "totally-bogus", confidence: "nope" }],
    });
    expect(out.items[0]!.status).toBe("missing");
    expect(out.items[0]!.confidence).toBe("LOW");
  });

  it("defaults missing array fields to empty arrays", () => {
    const out = ProductionComplianceResultSchema.parse({ summary: "s" });
    expect(out.items).toEqual([]);
    expect(out.rule115Flags).toEqual([]);
  });

  it("throws on a non-object response", () => {
    expect(() => ProductionComplianceResultSchema.parse("not json object")).toThrow();
    expect(() => ProductionComplianceResultSchema.parse([1, 2, 3])).toThrow();
  });
});

describe("AnalysisResultSchema (TS-001)", () => {
  it("guarantees the UI arrays exist even when the model omits them", () => {
    const out = AnalysisResultSchema.parse({ summary: "hello" });
    expect(out.potentialViolations).toEqual([]);
    expect(out.timeline).toEqual([]);
    expect(out.summary).toBe("hello");
  });
});
