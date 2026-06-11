// Integration tests against a dedicated Postgres test database (DATABASE_URL is
// set in vitest.config.ts and migrated beforehand). Exercises real discovery DB
// functions — no mocks. Tests are written to be safe against a persistent DB
// (relative assertions + cleanup) rather than assuming a fresh schema each run.
import { describe, it, expect, afterAll } from "vitest";
import {
  rollupProductionStatus,
  createCase,
  deleteCase,
  createSubpoena,
  getOverdueSubpoenas,
} from "../src/db/discovery.js";

const createdCaseIds: number[] = [];
afterAll(async () => {
  for (const id of createdCaseIds) await deleteCase(id);
});

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
  it("issues strictly increasing numbers and never reuses one after a delete", async () => {
    const seqOf = (docket: string) => Number(docket.match(/-(\d+)$/)![1]);

    const a = await createCase({ year: 2099 });
    const b = await createCase({ year: 2099 });
    const c = await createCase({ year: 2099 });
    createdCaseIds.push(a.id, b.id);
    const sa = seqOf(a.docket_number);
    const sb = seqOf(b.docket_number);
    const sc = seqOf(c.docket_number);
    expect(sb).toBe(sa + 1);
    expect(sc).toBe(sb + 1);

    // Delete the most recent, then create again — must NOT reissue sc.
    await deleteCase(c.id);
    const d = await createCase({ year: 2099 });
    createdCaseIds.push(d.id);
    expect(seqOf(d.docket_number)).toBe(sc + 1); // 0004-style, no reuse of 0003
  });
});

describe("getOverdueSubpoenas date boundary (TEST-011)", () => {
  it("returns a subpoena past its deadline but not one due today or with no deadline", async () => {
    const caseRow = await createCase({ year: 2098 });
    createdCaseIds.push(caseRow.id);
    await createSubpoena({
      case_id: caseRow.id,
      subpoena_type: "BOTH",
      response_deadline: "2098-01-01", // overdue (< today)
      requested_items: [],
    });
    await createSubpoena({
      case_id: caseRow.id,
      subpoena_type: "BOTH",
      response_deadline: "2098-06-10", // == today; query uses strict <, so NOT overdue
      requested_items: [],
    });
    await createSubpoena({
      case_id: caseRow.id,
      subpoena_type: "BOTH",
      response_deadline: null, // no deadline; never overdue
      requested_items: [],
    });

    const overdue = (await getOverdueSubpoenas("2098-06-10")).filter(
      (s) => s.case_id === caseRow.id,
    );
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.response_deadline).toBe("2098-01-01");
  });
});
