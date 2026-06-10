// Integration tests against an in-memory SQLite DB (DATABASE_PATH=:memory: is set
// in vitest.config.ts). Exercises real discovery DB functions — no mocks.
import { describe, it, expect } from "vitest";
import {
  rollupProductionStatus,
  createCase,
  deleteCase,
  createSubpoena,
  getOverdueSubpoenas,
} from "../src/db/discovery.js";

describe("rollupProductionStatus (TEST-005)", () => {
  it("returns 'pending' for no items", () => {
    expect(rollupProductionStatus([])).toBe("pending");
  });
  it("returns 'complete' when every item is received", () => {
    expect(rollupProductionStatus([{ status: "received" }, { status: "received" }])).toBe(
      "complete",
    );
  });
  it("lets 'defective' dominate even when others are received", () => {
    expect(rollupProductionStatus([{ status: "received" }, { status: "defective" }])).toBe(
      "defective",
    );
  });
  it("degrades to 'partial' when an item is missing", () => {
    expect(rollupProductionStatus([{ status: "received" }, { status: "missing" }])).toBe("partial");
  });
});

describe("nextDocketNumber via createCase (TEST-008 / DB-009)", () => {
  it("never reuses a docket number after a delete", () => {
    const a = createCase({ year: 2099 });
    const b = createCase({ year: 2099 });
    const c = createCase({ year: 2099 });
    expect([a.docket_number, b.docket_number, c.docket_number]).toEqual([
      "ODC-2099-0001",
      "ODC-2099-0002",
      "ODC-2099-0003",
    ]);
    // Delete the most recent, then create again — must NOT reissue 0003.
    deleteCase(c.id);
    const d = createCase({ year: 2099 });
    expect(d.docket_number).toBe("ODC-2099-0004");
  });
});

describe("getOverdueSubpoenas date boundary (TEST-011)", () => {
  it("returns a subpoena past its deadline but not one due today or with no deadline", () => {
    const caseRow = createCase({ year: 2098 });
    // Overdue: deadline before 'today'
    createSubpoena({
      case_id: caseRow.id,
      subpoena_type: "BOTH",
      response_deadline: "2098-01-01",
      requested_items: [],
    });
    // Not overdue: deadline equals 'today' (the query uses strict <)
    createSubpoena({
      case_id: caseRow.id,
      subpoena_type: "BOTH",
      response_deadline: "2098-06-10",
      requested_items: [],
    });
    // Not overdue: no deadline set
    createSubpoena({
      case_id: caseRow.id,
      subpoena_type: "BOTH",
      response_deadline: null,
      requested_items: [],
    });

    const overdue = getOverdueSubpoenas("2098-06-10").filter((s) => s.case_id === caseRow.id);
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.response_deadline).toBe("2098-01-01");
  });
});
