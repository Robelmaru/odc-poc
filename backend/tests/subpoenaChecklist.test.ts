import { describe, it, expect } from "vitest";
import {
  SUBPOENA_CHECKLIST,
  defaultRequestedItems,
  checklistForBucket,
  checklistItemById,
} from "../src/knowledge/subpoenaChecklist.js";

describe("subpoena checklist seed (TEST-010)", () => {
  it("seeds exactly 12 distinct gradeable items", () => {
    const items = defaultRequestedItems();
    expect(items).toHaveLength(12);
    const ids = items.map((i) => i.item_type);
    expect(new Set(ids).size).toBe(12); // no duplicate item_types
  });

  it("splits into 5 office_file + 7 financial_records items", () => {
    expect(checklistForBucket("office_file")).toHaveLength(5);
    expect(checklistForBucket("financial_records")).toHaveLength(7);
  });

  it("includes both Rule 1.15 misappropriation-signal items", () => {
    const flagged = SUBPOENA_CHECKLIST.filter((i) => i.rule115Signal).map((i) => i.id);
    expect(flagged).toContain("general_ledger");
    expect(flagged).toContain("subsidiary_client_ledger");
  });

  it("looks up an item by id and returns undefined for an unknown id", () => {
    expect(checklistItemById("fee_agreement")?.bucket).toBe("office_file");
    expect(checklistItemById("does_not_exist")).toBeUndefined();
  });
});
