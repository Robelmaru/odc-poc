// Discovery data model: the case-lifecycle spine (PostgreSQL via ./client.ts).
//
//   respondent_attorneys
//        │
//      cases ──< subpoenas ──< productions ──< production_items
//                                  │
//                                  └─ links to an existing timeline_records row
//
// Schema + migrations are owned by Drizzle (src/db/schema.ts, migrations/).
// FK ON DELETE cascades (subpoenas→cases, productions→subpoenas, items/jobs→
// productions) mean deletes cascade in the database; the manual cascade loops the
// SQLite version needed are gone.
import { query, queryOne, execute, withTransaction } from "./client.js";

// ── Interfaces ────────────────────────────────────────────────────────────

export interface RespondentAttorney {
  id: number;
  bar_number: string | null;
  name: string;
  firm: string | null;
  email: string | null;
  phone: string | null;
  bar_status: string | null;
  created_at: string;
}

export interface CaseRow {
  id: number;
  docket_number: string;
  respondent_id: number | null;
  complainant_name: string | null;
  client_name: string | null;
  matter_caption: string | null;
  phase: string;
  status: string;
  analysis_record_id: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubpoenaRow {
  id: number;
  case_id: number;
  subpoena_type: string;
  issuance_date: string | null;
  response_deadline: string | null;
  extended_deadline: string | null;
  status: string;
  requested_items: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductionRow {
  id: number;
  subpoena_id: number;
  received_date: string | null;
  version_number: number;
  superseded_by: number | null;
  status: string;
  timeline_record_id: number | null;
  page_count: number | null;
  text_chars_per_page: number | null;
  is_image_only: number | null;
  ocr_status: string | null;
  redaction_status: string | null;
  rule115_flags: string | null;
  follow_up: string | null;
  notes: string | null;
  created_at: string;
}

export interface ProductionItemRow {
  id: number;
  production_id: number;
  item_type: string;
  status: string;
  source_section_id: string | null;
  confidence: string | null;
  notes: string | null;
  created_at: string;
}

export interface ProductionJobRow {
  id: number;
  production_id: number;
  status: string;
  message: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ── Respondent attorneys ────────────────────────────────────────────────────

export async function createRespondent(p: {
  name: string;
  bar_number?: string | null;
  firm?: string | null;
  email?: string | null;
  phone?: string | null;
}) {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO respondent_attorneys (name, bar_number, firm, email, phone) VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [p.name, p.bar_number ?? null, p.firm ?? null, p.email ?? null, p.phone ?? null],
  );
  return { id: row!.id };
}

export async function getRespondent(id: number): Promise<RespondentAttorney | undefined> {
  return queryOne<RespondentAttorney>(`SELECT * FROM respondent_attorneys WHERE id = ?`, [id]);
}

export async function findRespondentByBar(
  barNumber: string,
): Promise<RespondentAttorney | undefined> {
  return queryOne<RespondentAttorney>(`SELECT * FROM respondent_attorneys WHERE bar_number = ?`, [
    barNumber,
  ]);
}

export async function listRespondents(): Promise<RespondentAttorney[]> {
  return query<RespondentAttorney>(`SELECT * FROM respondent_attorneys ORDER BY name`);
}

// ── Cases ────────────────────────────────────────────────────────────────────

/**
 * Next docket number for the year (e.g. ODC-2026-0001). Monotonic, atomic
 * per-year counter (DB-009): never reuses a number after a delete.
 */
export async function nextDocketNumber(year: number): Promise<string> {
  const seq = await withTransaction(async (q) => {
    await q(
      `INSERT INTO docket_sequences (year, last_seq) VALUES (?, 0) ON CONFLICT (year) DO NOTHING`,
      [year],
    );
    await q(`UPDATE docket_sequences SET last_seq = last_seq + 1 WHERE year = ?`, [year]);
    const rows = await q<{ last_seq: number }>(
      `SELECT last_seq FROM docket_sequences WHERE year = ?`,
      [year],
    );
    return rows[0]!.last_seq;
  });
  return `ODC-${year}-${String(seq).padStart(4, "0")}`;
}

export async function createCase(p: {
  year: number;
  respondent_id?: number | null;
  complainant_name?: string | null;
  client_name?: string | null;
  matter_caption?: string | null;
  analysis_record_id?: number | null;
  created_by?: string | null;
}) {
  const docket = await nextDocketNumber(p.year);
  const row = await queryOne<{ id: number }>(
    `INSERT INTO cases (docket_number, respondent_id, complainant_name, client_name, matter_caption, analysis_record_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      docket,
      p.respondent_id ?? null,
      p.complainant_name ?? null,
      p.client_name ?? null,
      p.matter_caption ?? null,
      p.analysis_record_id ?? null,
      p.created_by ?? null,
    ],
  );
  return { id: row!.id, docket_number: docket };
}

export async function getCase(id: number): Promise<CaseRow | undefined> {
  return queryOne<CaseRow>(`SELECT * FROM cases WHERE id = ?`, [id]);
}

export async function listCases(): Promise<CaseRow[]> {
  return query<CaseRow>(`SELECT * FROM cases ORDER BY created_at DESC`);
}

const CASE_PHASES = ["intake", "investigation_discovery", "charging", "hearing", "appellate"];
const CASE_STATUSES = ["open", "closed", "flagged"];

export async function updateCasePhase(id: number, phase: string): Promise<boolean> {
  if (!CASE_PHASES.includes(phase)) return false;
  await execute(`UPDATE cases SET phase = ?, updated_at = now() WHERE id = ?`, [phase, id]);
  return true;
}

export async function updateCaseStatus(id: number, status: string): Promise<boolean> {
  if (!CASE_STATUSES.includes(status)) return false;
  await execute(`UPDATE cases SET status = ?, updated_at = now() WHERE id = ?`, [status, id]);
  return true;
}

/** Hard-delete a case; FK cascades remove its subpoenas → productions → items/jobs. */
export async function deleteCase(caseId: number): Promise<{ changes: number }> {
  return withTransaction(async (q) => {
    // Saved timeline records are preserved (still in My Records); just unlink them.
    await q(`UPDATE timeline_records SET case_id = NULL, production_id = NULL WHERE case_id = ?`, [
      caseId,
    ]);
    const deleted = await q(`DELETE FROM cases WHERE id = ? RETURNING id`, [caseId]);
    return { changes: deleted.length };
  });
}

export { CASE_PHASES, CASE_STATUSES };

// ── Subpoenas ─────────────────────────────────────────────────────────────

export async function createSubpoena(p: {
  case_id: number;
  subpoena_type: string;
  issuance_date?: string | null;
  response_deadline?: string | null;
  requested_items: { item_type: string; description: string }[];
  created_by?: string | null;
}) {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO subpoenas (case_id, subpoena_type, issuance_date, response_deadline, requested_items, created_by)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      p.case_id,
      p.subpoena_type,
      p.issuance_date ?? null,
      p.response_deadline ?? null,
      JSON.stringify(p.requested_items),
      p.created_by ?? null,
    ],
  );
  return { id: row!.id };
}

export async function getSubpoena(id: number): Promise<SubpoenaRow | undefined> {
  return queryOne<SubpoenaRow>(`SELECT * FROM subpoenas WHERE id = ?`, [id]);
}

export async function listSubpoenasByCase(caseId: number): Promise<SubpoenaRow[]> {
  return query<SubpoenaRow>(`SELECT * FROM subpoenas WHERE case_id = ? ORDER BY created_at DESC`, [
    caseId,
  ]);
}

const SUBPOENA_STATUSES = [
  "issued",
  "partially_received",
  "fully_received",
  "overdue",
  "withdrawn",
];

export async function updateSubpoenaStatus(id: number, status: string): Promise<boolean> {
  if (!SUBPOENA_STATUSES.includes(status)) return false;
  await execute(`UPDATE subpoenas SET status = ?, updated_at = now() WHERE id = ?`, [status, id]);
  return true;
}

export async function extendSubpoenaDeadline(id: number, newDeadline: string) {
  await execute(`UPDATE subpoenas SET extended_deadline = ?, updated_at = now() WHERE id = ?`, [
    newDeadline,
    id,
  ]);
}

export { SUBPOENA_STATUSES };

/** Overdue subpoenas: effective deadline (extended ?? response) passed, not yet received/withdrawn. */
export async function getOverdueSubpoenas(
  today: string,
): Promise<(SubpoenaRow & { docket_number: string })[]> {
  return query<SubpoenaRow & { docket_number: string }>(
    `SELECT s.*, c.docket_number
       FROM subpoenas s JOIN cases c ON c.id = s.case_id
      WHERE s.status NOT IN ('fully_received', 'withdrawn')
        AND COALESCE(s.extended_deadline, s.response_deadline) IS NOT NULL
        AND COALESCE(s.extended_deadline, s.response_deadline) < ?
      ORDER BY COALESCE(s.extended_deadline, s.response_deadline) ASC`,
    [today],
  );
}

// ── Productions ─────────────────────────────────────────────────────────────

export async function createProduction(p: {
  subpoena_id: number;
  received_date?: string | null;
  version_number?: number;
  notes?: string | null;
}) {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO productions (subpoena_id, received_date, version_number, notes) VALUES (?, ?, ?, ?) RETURNING id`,
    [p.subpoena_id, p.received_date ?? null, p.version_number ?? 1, p.notes ?? null],
  );
  return { id: row!.id };
}

export async function getProduction(id: number): Promise<ProductionRow | undefined> {
  return queryOne<ProductionRow>(`SELECT * FROM productions WHERE id = ?`, [id]);
}

export async function listProductionsBySubpoena(subpoenaId: number): Promise<ProductionRow[]> {
  return query<ProductionRow>(
    `SELECT * FROM productions WHERE subpoena_id = ? ORDER BY version_number ASC`,
    [subpoenaId],
  );
}

/** Record intake characterization computed from the pdfUtils extraction. */
export async function updateProductionIntake(
  id: number,
  p: {
    page_count?: number | null;
    text_chars_per_page?: number | null;
    is_image_only?: boolean | null;
    ocr_status?: string | null;
    redaction_status?: string | null;
    timeline_record_id?: number | null;
  },
) {
  await execute(
    `UPDATE productions
        SET page_count = COALESCE(?, page_count),
            text_chars_per_page = COALESCE(?, text_chars_per_page),
            is_image_only = COALESCE(?, is_image_only),
            ocr_status = COALESCE(?, ocr_status),
            redaction_status = COALESCE(?, redaction_status),
            timeline_record_id = COALESCE(?, timeline_record_id)
      WHERE id = ?`,
    [
      p.page_count ?? null,
      p.text_chars_per_page ?? null,
      p.is_image_only == null ? null : p.is_image_only ? 1 : 0,
      p.ocr_status ?? null,
      p.redaction_status ?? null,
      p.timeline_record_id ?? null,
      id,
    ],
  );
}

export async function updateProductionStatus(id: number, status: string) {
  await execute(`UPDATE productions SET status = ? WHERE id = ?`, [status, id]);
}

/** Hard-delete a single production; FK cascades remove its items/jobs. */
export async function deleteProduction(id: number): Promise<{ changes: number }> {
  const changes = await execute(`DELETE FROM productions WHERE id = ?`, [id]);
  return { changes };
}

export async function setProductionReconcileMeta(
  id: number,
  p: { rule115_flags: string[]; follow_up: string },
) {
  await execute(`UPDATE productions SET rule115_flags = ?, follow_up = ? WHERE id = ?`, [
    JSON.stringify(p.rule115_flags || []),
    p.follow_up || "",
    id,
  ]);
}

// ── Production items (reconciliation results) ───────────────────────────────

/** Replace all reconciliation items for a production (idempotent re-runs). */
export async function replaceProductionItems(
  productionId: number,
  items: {
    item_type: string;
    status: string;
    source_section_id?: string | null;
    confidence?: string | null;
    notes?: string | null;
  }[],
) {
  await withTransaction(async (q) => {
    await q(`DELETE FROM production_items WHERE production_id = ?`, [productionId]);
    for (const it of items) {
      await q(
        `INSERT INTO production_items (production_id, item_type, status, source_section_id, confidence, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          productionId,
          it.item_type,
          it.status,
          it.source_section_id ?? null,
          it.confidence ?? null,
          it.notes ?? null,
        ],
      );
    }
  });
}

/** Link a saved timeline_records row back to its case + production (roadmap link columns). */
export async function linkTimelineRecordToCase(
  recordId: number,
  caseId: number,
  productionId: number,
) {
  await execute(`UPDATE timeline_records SET case_id = ?, production_id = ? WHERE id = ?`, [
    caseId,
    productionId,
    recordId,
  ]);
}

export async function getProductionItems(productionId: number): Promise<ProductionItemRow[]> {
  return query<ProductionItemRow>(
    `SELECT * FROM production_items WHERE production_id = ? ORDER BY id ASC`,
    [productionId],
  );
}

// ── Production jobs (background processing) ─────────────────────────────────

export async function createProductionJob(productionId: number): Promise<{ id: number }> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO production_jobs (production_id, status, message) VALUES (?, 'queued', 'Queued') RETURNING id`,
    [productionId],
  );
  return { id: row!.id };
}

export async function updateProductionJob(
  id: number,
  p: { status?: string; message?: string | null; error?: string | null },
) {
  await execute(
    `UPDATE production_jobs
        SET status  = COALESCE(?, status),
            message = COALESCE(?, message),
            error   = COALESCE(?, error),
            updated_at = now()
      WHERE id = ?`,
    [p.status ?? null, p.message ?? null, p.error ?? null, id],
  );
}

export async function getLatestProductionJob(
  productionId: number,
): Promise<ProductionJobRow | undefined> {
  return queryOne<ProductionJobRow>(
    `SELECT * FROM production_jobs WHERE production_id = ? ORDER BY id DESC LIMIT 1`,
    [productionId],
  );
}

/** Roll a production's status up from its item statuses (pure). */
export function rollupProductionStatus(
  items: { status: string }[],
): "complete" | "partial" | "defective" | "pending" {
  if (items.length === 0) return "pending";
  const has = (s: string) => items.some((i) => i.status === s);
  if (has("defective")) return "defective";
  if (has("missing") || has("partial") || has("pending")) return "partial";
  return "complete";
}
