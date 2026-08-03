// Integration tests for DB-006 record sharing via the record_shares junction
// table (against the dedicated Postgres test DB). Verifies that sharing makes a
// record visible to the recipient, keeps the shared_with cache in sync, isolates
// non-recipients, and that clearing shares revokes visibility.
import { describe, it, expect, afterAll } from "vitest";
import {
  insertRecord,
  updateRecordSharing,
  getRecordsByStaff,
  getRecordById,
  deleteRecord,
} from "../src/db/database.js";

const OWNER = "vitest_share_owner";
const FRIEND = "vitest_share_friend";
const STRANGER = "vitest_share_stranger";

const createdIds: number[] = [];
afterAll(async () => {
  for (const id of createdIds) await deleteRecord(id, OWNER).catch(() => {});
});

async function makeRecord(): Promise<number> {
  const res = await insertRecord({
    staff_id: OWNER,
    record_name: "share-test",
    file_names: JSON.stringify(["a.pdf"]),
    notes: null,
    timeline: JSON.stringify({ timeline: [] }),
  });
  const id = Number(res.lastInsertRowid);
  createdIds.push(id);
  return id;
}

const sees = async (staff: string, id: number) =>
  (await getRecordsByStaff(staff)).some((r) => (r as { id: number }).id === id);

describe("DB-006 — sharing via record_shares", () => {
  it("makes a record visible to the recipient and updates the shared_with cache", async () => {
    const id = await makeRecord();
    expect(await sees(FRIEND, id)).toBe(false); // not shared yet

    await updateRecordSharing([FRIEND], id);

    expect(await sees(FRIEND, id)).toBe(true); // shared → visible via junction
    expect(await sees(OWNER, id)).toBe(true); // owner still sees it
    const row = await getRecordById(id);
    expect(JSON.parse(row!.shared_with)).toEqual([FRIEND]); // cache kept in sync
  });

  it("does not leak the record to an unrelated staff member", async () => {
    const id = await makeRecord();
    await updateRecordSharing([FRIEND], id);
    expect(await sees(STRANGER, id)).toBe(false);
  });

  it("revokes visibility when shares are cleared", async () => {
    const id = await makeRecord();
    await updateRecordSharing([FRIEND], id);
    expect(await sees(FRIEND, id)).toBe(true);

    await updateRecordSharing([], id);

    expect(await sees(FRIEND, id)).toBe(false);
    expect(JSON.parse((await getRecordById(id))!.shared_with)).toEqual([]);
  });
});
