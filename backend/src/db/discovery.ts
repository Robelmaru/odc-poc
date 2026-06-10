// Discovery data model: the case-lifecycle spine.
//
//   respondent_attorneys
//        │
//      cases ──< subpoenas ──< productions ──< production_items
//                                  │
//                                  └─ links to an existing timeline_records row
//                                     (the extracted/sectioned production file)
//
// Reuses the shared better-sqlite3 connection from database.ts and the same
// CREATE TABLE IF NOT EXISTS / addColumnIfMissing migration approach.

import db from "./database.js";

// Local copy of the migration helper (mirrors database.ts).
const addColumnIfMissing = (table: string, column: string, definition: string) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!cols.find((c: any) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS respondent_attorneys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bar_number  TEXT,
    name        TEXT NOT NULL,
    firm        TEXT,
    email       TEXT,
    phone       TEXT,
    bar_status  TEXT,                       -- Active | Inactive | Suspended (nullable)
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cases (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    docket_number      TEXT UNIQUE NOT NULL,            -- e.g. ODC-2026-0001
    respondent_id      INTEGER REFERENCES respondent_attorneys(id),
    complainant_name   TEXT,
    client_name        TEXT,                            -- the client whose matter is at issue
    matter_caption     TEXT,
    phase              TEXT NOT NULL DEFAULT 'intake',  -- intake|investigation_discovery|charging|hearing|appellate
    status             TEXT NOT NULL DEFAULT 'open',    -- open|closed|flagged
    analysis_record_id INTEGER,                         -- optional link to a saved AnalyzeComplaint result
    created_by         TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subpoenas (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id           INTEGER NOT NULL REFERENCES cases(id),
    subpoena_type     TEXT NOT NULL DEFAULT 'BOTH',     -- CLIENT_FILE | FINANCIAL_RECORDS | BOTH
    issuance_date     TEXT,
    response_deadline TEXT,
    extended_deadline TEXT,
    status            TEXT NOT NULL DEFAULT 'issued',   -- issued|partially_received|fully_received|overdue|withdrawn
    requested_items   TEXT NOT NULL DEFAULT '[]',       -- JSON [{item_type, description}]
    created_by        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS productions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    subpoena_id         INTEGER NOT NULL REFERENCES subpoenas(id),
    received_date       TEXT,
    version_number      INTEGER NOT NULL DEFAULT 1,
    superseded_by       INTEGER REFERENCES productions(id),
    status              TEXT NOT NULL DEFAULT 'pending', -- pending|complete|partial|defective
    timeline_record_id  INTEGER,                         -- the extracted/sectioned file (timeline_records.id)
    -- intake characterization (from the pdfUtils extraction)
    page_count          INTEGER,
    text_chars_per_page REAL,
    is_image_only       INTEGER,                         -- 0/1; needs Vision OCR before reconciliation
    ocr_status          TEXT DEFAULT 'not_needed',       -- not_needed|pending|done|failed
    redaction_status    TEXT DEFAULT 'unknown',          -- unknown|unredacted|redacted|mixed
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS production_items (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    production_id     INTEGER NOT NULL REFERENCES productions(id),
    item_type         TEXT NOT NULL,                     -- a SUBPOENA_CHECKLIST id
    status            TEXT NOT NULL DEFAULT 'pending',   -- received|partial|missing|defective|pending
    source_section_id TEXT,                              -- DocumentTimeline section that satisfies it
    confidence        TEXT,                              -- HIGH|MEDIUM|LOW (model confidence)
    notes             TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS production_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    production_id INTEGER NOT NULL REFERENCES productions(id),
    status        TEXT NOT NULL DEFAULT 'queued', -- queued|extracting|sectioning|reconciling|done|failed
    message       TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_subpoenas_case        ON subpoenas(case_id);
  CREATE INDEX IF NOT EXISTS idx_productions_subpoena  ON productions(subpoena_id);
  CREATE INDEX IF NOT EXISTS idx_prod_items_production ON production_items(production_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_production       ON production_jobs(production_id);
`);

// Link existing timeline_records back to a case / production (per the roadmap).
addColumnIfMissing("timeline_records", "case_id", "INTEGER");
addColumnIfMissing("timeline_records", "production_id", "INTEGER");

// Persist the reconciliation narrative so it survives a page refresh.
addColumnIfMissing("productions", "rule115_flags", "TEXT"); // JSON string[]
addColumnIfMissing("productions", "follow_up", "TEXT"); // deficiency-letter draft

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

// ── Respondent attorneys ────────────────────────────────────────────────────

export function createRespondent(p: {
  name: string;
  bar_number?: string | null;
  firm?: string | null;
  email?: string | null;
  phone?: string | null;
}) {
  const r = db
    .prepare(
      `INSERT INTO respondent_attorneys (name, bar_number, firm, email, phone) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(p.name, p.bar_number ?? null, p.firm ?? null, p.email ?? null, p.phone ?? null);
  return { id: Number(r.lastInsertRowid) };
}

export function getRespondent(id: number): RespondentAttorney | undefined {
  return db.prepare(`SELECT * FROM respondent_attorneys WHERE id = ?`).get(id) as
    | RespondentAttorney
    | undefined;
}

export function findRespondentByBar(barNumber: string): RespondentAttorney | undefined {
  return db.prepare(`SELECT * FROM respondent_attorneys WHERE bar_number = ?`).get(barNumber) as
    | RespondentAttorney
    | undefined;
}

export function listRespondents(): RespondentAttorney[] {
  return db
    .prepare(`SELECT * FROM respondent_attorneys ORDER BY name`)
    .all() as RespondentAttorney[];
}

// ── Cases ────────────────────────────────────────────────────────────────────

/** Generate the next docket number for the given year, e.g. ODC-2026-0001. */
export function nextDocketNumber(year: number): string {
  const prefix = `ODC-${year}-`;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM cases WHERE docket_number LIKE ?`)
    .get(prefix + "%") as { n: number };
  const seq = String(row.n + 1).padStart(4, "0");
  return `${prefix}${seq}`;
}

export function createCase(p: {
  year: number;
  respondent_id?: number | null;
  complainant_name?: string | null;
  client_name?: string | null;
  matter_caption?: string | null;
  analysis_record_id?: number | null;
  created_by?: string | null;
}) {
  const docket = nextDocketNumber(p.year);
  const r = db
    .prepare(
      `INSERT INTO cases (docket_number, respondent_id, complainant_name, client_name, matter_caption, analysis_record_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      docket,
      p.respondent_id ?? null,
      p.complainant_name ?? null,
      p.client_name ?? null,
      p.matter_caption ?? null,
      p.analysis_record_id ?? null,
      p.created_by ?? null,
    );
  return { id: Number(r.lastInsertRowid), docket_number: docket };
}

export function getCase(id: number): CaseRow | undefined {
  return db.prepare(`SELECT * FROM cases WHERE id = ?`).get(id) as CaseRow | undefined;
}

export function listCases(): CaseRow[] {
  return db.prepare(`SELECT * FROM cases ORDER BY created_at DESC`).all() as CaseRow[];
}

const CASE_PHASES = ["intake", "investigation_discovery", "charging", "hearing", "appellate"];
const CASE_STATUSES = ["open", "closed", "flagged"];

export function updateCasePhase(id: number, phase: string): boolean {
  if (!CASE_PHASES.includes(phase)) return false;
  db.prepare(`UPDATE cases SET phase = ?, updated_at = datetime('now') WHERE id = ?`).run(
    phase,
    id,
  );
  return true;
}

export function updateCaseStatus(id: number, status: string): boolean {
  if (!CASE_STATUSES.includes(status)) return false;
  db.prepare(`UPDATE cases SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
    status,
    id,
  );
  return true;
}

/** Hard-delete a case and everything under it (subpoenas → productions → items/jobs). */
export function deleteCase(caseId: number): { changes: number } {
  const txn = db.transaction(() => {
    const subs = db.prepare(`SELECT id FROM subpoenas WHERE case_id = ?`).all(caseId) as {
      id: number;
    }[];
    for (const s of subs) {
      const prods = db.prepare(`SELECT id FROM productions WHERE subpoena_id = ?`).all(s.id) as {
        id: number;
      }[];
      for (const p of prods) {
        db.prepare(`DELETE FROM production_items WHERE production_id = ?`).run(p.id);
        db.prepare(`DELETE FROM production_jobs WHERE production_id = ?`).run(p.id);
      }
      db.prepare(`DELETE FROM productions WHERE subpoena_id = ?`).run(s.id);
    }
    db.prepare(`DELETE FROM subpoenas WHERE case_id = ?`).run(caseId);
    // Saved timeline records are intentionally preserved (still visible in My Records);
    // just unlink them from the deleted case.
    db.prepare(
      `UPDATE timeline_records SET case_id = NULL, production_id = NULL WHERE case_id = ?`,
    ).run(caseId);
    return db.prepare(`DELETE FROM cases WHERE id = ?`).run(caseId).changes;
  });
  return { changes: txn() as number };
}

export { CASE_PHASES, CASE_STATUSES };

// ── Subpoenas ─────────────────────────────────────────────────────────────

export function createSubpoena(p: {
  case_id: number;
  subpoena_type: string;
  issuance_date?: string | null;
  response_deadline?: string | null;
  requested_items: { item_type: string; description: string }[];
  created_by?: string | null;
}) {
  const r = db
    .prepare(
      `INSERT INTO subpoenas (case_id, subpoena_type, issuance_date, response_deadline, requested_items, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.case_id,
      p.subpoena_type,
      p.issuance_date ?? null,
      p.response_deadline ?? null,
      JSON.stringify(p.requested_items),
      p.created_by ?? null,
    );
  return { id: Number(r.lastInsertRowid) };
}

export function getSubpoena(id: number): SubpoenaRow | undefined {
  return db.prepare(`SELECT * FROM subpoenas WHERE id = ?`).get(id) as SubpoenaRow | undefined;
}

export function listSubpoenasByCase(caseId: number): SubpoenaRow[] {
  return db
    .prepare(`SELECT * FROM subpoenas WHERE case_id = ? ORDER BY created_at DESC`)
    .all(caseId) as SubpoenaRow[];
}

const SUBPOENA_STATUSES = [
  "issued",
  "partially_received",
  "fully_received",
  "overdue",
  "withdrawn",
];

export function updateSubpoenaStatus(id: number, status: string): boolean {
  if (!SUBPOENA_STATUSES.includes(status)) return false;
  db.prepare(`UPDATE subpoenas SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(
    status,
    id,
  );
  return true;
}

export function extendSubpoenaDeadline(id: number, newDeadline: string) {
  db.prepare(
    `UPDATE subpoenas SET extended_deadline = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(newDeadline, id);
}

export { SUBPOENA_STATUSES };

/**
 * Subpoenas whose effective deadline (extended_deadline ?? response_deadline) has
 * passed and that are not yet fully received/withdrawn. `today` is YYYY-MM-DD.
 */
export function getOverdueSubpoenas(today: string): (SubpoenaRow & { docket_number: string })[] {
  return db
    .prepare(
      `SELECT s.*, c.docket_number
         FROM subpoenas s JOIN cases c ON c.id = s.case_id
        WHERE s.status NOT IN ('fully_received', 'withdrawn')
          AND COALESCE(s.extended_deadline, s.response_deadline) IS NOT NULL
          AND COALESCE(s.extended_deadline, s.response_deadline) < ?
        ORDER BY COALESCE(s.extended_deadline, s.response_deadline) ASC`,
    )
    .all(today) as (SubpoenaRow & { docket_number: string })[];
}

// ── Productions ─────────────────────────────────────────────────────────────

export function createProduction(p: {
  subpoena_id: number;
  received_date?: string | null;
  version_number?: number;
  notes?: string | null;
}) {
  const r = db
    .prepare(
      `INSERT INTO productions (subpoena_id, received_date, version_number, notes)
       VALUES (?, ?, ?, ?)`,
    )
    .run(p.subpoena_id, p.received_date ?? null, p.version_number ?? 1, p.notes ?? null);
  return { id: Number(r.lastInsertRowid) };
}

export function getProduction(id: number): ProductionRow | undefined {
  return db.prepare(`SELECT * FROM productions WHERE id = ?`).get(id) as ProductionRow | undefined;
}

export function listProductionsBySubpoena(subpoenaId: number): ProductionRow[] {
  return db
    .prepare(`SELECT * FROM productions WHERE subpoena_id = ? ORDER BY version_number ASC`)
    .all(subpoenaId) as ProductionRow[];
}

/** Record intake characterization computed from the pdfUtils extraction. */
export function updateProductionIntake(
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
  db.prepare(
    `UPDATE productions
        SET page_count = COALESCE(?, page_count),
            text_chars_per_page = COALESCE(?, text_chars_per_page),
            is_image_only = COALESCE(?, is_image_only),
            ocr_status = COALESCE(?, ocr_status),
            redaction_status = COALESCE(?, redaction_status),
            timeline_record_id = COALESCE(?, timeline_record_id)
      WHERE id = ?`,
  ).run(
    p.page_count ?? null,
    p.text_chars_per_page ?? null,
    p.is_image_only == null ? null : p.is_image_only ? 1 : 0,
    p.ocr_status ?? null,
    p.redaction_status ?? null,
    p.timeline_record_id ?? null,
    id,
  );
}

export function updateProductionStatus(id: number, status: string) {
  db.prepare(`UPDATE productions SET status = ? WHERE id = ?`).run(status, id);
}

/** Hard-delete a single production and its items/jobs. */
export function deleteProduction(id: number): { changes: number } {
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM production_items WHERE production_id = ?`).run(id);
    db.prepare(`DELETE FROM production_jobs WHERE production_id = ?`).run(id);
    return db.prepare(`DELETE FROM productions WHERE id = ?`).run(id).changes;
  });
  return { changes: txn() as number };
}

export function setProductionReconcileMeta(
  id: number,
  p: { rule115_flags: string[]; follow_up: string },
) {
  db.prepare(`UPDATE productions SET rule115_flags = ?, follow_up = ? WHERE id = ?`).run(
    JSON.stringify(p.rule115_flags || []),
    p.follow_up || "",
    id,
  );
}

// ── Production items (reconciliation results) ───────────────────────────────

/** Replace all reconciliation items for a production (idempotent re-runs). */
export function replaceProductionItems(
  productionId: number,
  items: {
    item_type: string;
    status: string;
    source_section_id?: string | null;
    confidence?: string | null;
    notes?: string | null;
  }[],
) {
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM production_items WHERE production_id = ?`).run(productionId);
    const ins = db.prepare(
      `INSERT INTO production_items (production_id, item_type, status, source_section_id, confidence, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const it of items) {
      ins.run(
        productionId,
        it.item_type,
        it.status,
        it.source_section_id ?? null,
        it.confidence ?? null,
        it.notes ?? null,
      );
    }
  });
  txn();
}

/** Link a saved timeline_records row back to its case + production (roadmap link columns). */
export function linkTimelineRecordToCase(recordId: number, caseId: number, productionId: number) {
  db.prepare(`UPDATE timeline_records SET case_id = ?, production_id = ? WHERE id = ?`).run(
    caseId,
    productionId,
    recordId,
  );
}

export function getProductionItems(productionId: number): ProductionItemRow[] {
  return db
    .prepare(`SELECT * FROM production_items WHERE production_id = ? ORDER BY id ASC`)
    .all(productionId) as ProductionItemRow[];
}

// ── Production jobs (background processing) ─────────────────────────────────

export interface ProductionJobRow {
  id: number;
  production_id: number;
  status: string;
  message: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function createProductionJob(productionId: number): { id: number } {
  const r = db
    .prepare(
      `INSERT INTO production_jobs (production_id, status, message) VALUES (?, 'queued', 'Queued')`,
    )
    .run(productionId);
  return { id: Number(r.lastInsertRowid) };
}

export function updateProductionJob(
  id: number,
  p: { status?: string; message?: string | null; error?: string | null },
) {
  db.prepare(
    `UPDATE production_jobs
        SET status  = COALESCE(?, status),
            message = COALESCE(?, message),
            error   = COALESCE(?, error),
            updated_at = datetime('now')
      WHERE id = ?`,
  ).run(p.status ?? null, p.message ?? null, p.error ?? null, id);
}

export function getLatestProductionJob(productionId: number): ProductionJobRow | undefined {
  return db
    .prepare(`SELECT * FROM production_jobs WHERE production_id = ? ORDER BY id DESC LIMIT 1`)
    .get(productionId) as ProductionJobRow | undefined;
}

/** Roll a production's status up from its item statuses. */
export function rollupProductionStatus(
  items: { status: string }[],
): "complete" | "partial" | "defective" | "pending" {
  if (items.length === 0) return "pending";
  const has = (s: string) => items.some((i) => i.status === s);
  if (has("defective")) return "defective";
  if (has("missing") || has("partial") || has("pending")) return "partial";
  return "complete";
}
