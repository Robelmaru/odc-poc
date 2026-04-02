import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DATABASE_HOST || "localhost",
  port: Number(process.env.DATABASE_PORT) || 5432,
  user: process.env.DATABASE_USER || "postgres",
  password: process.env.DATABASE_PASSWORD || "",
  database: process.env.DATABASE_NAME || "document_analyzer",
});

// Create tables
await pool.query(`
  CREATE TABLE IF NOT EXISTS timeline_records (
    id          SERIAL PRIMARY KEY,
    staff_id    TEXT    NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    record_name TEXT,
    case_number TEXT,
    shared_with TEXT    DEFAULT '[]',
    file_names  TEXT    NOT NULL,
    notes       TEXT,
    summary     TEXT,
    status      TEXT    DEFAULT 'draft',
    tags        TEXT    DEFAULT '[]',
    timeline    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS translation_records (
    id            SERIAL PRIMARY KEY,
    staff_id      TEXT    NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    record_name   TEXT,
    file_names    TEXT    NOT NULL,
    language      TEXT    NOT NULL,
    language_name TEXT    NOT NULL,
    status        TEXT    DEFAULT 'draft',
    tags          TEXT    DEFAULT '[]',
    translation   TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         SERIAL PRIMARY KEY,
    staff_id   TEXT    NOT NULL,
    message    TEXT    NOT NULL,
    link       TEXT,
    read       BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS staff_sessions (
    staff_id    TEXT PRIMARY KEY,
    last_active TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id         SERIAL PRIMARY KEY,
    staff_id   TEXT    NOT NULL,
    action     TEXT    NOT NULL,
    details    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

// ── Interfaces ────────────────────────────────────────────────────────────

export interface TimelineRecord {
  id: number;
  staff_id: string;
  created_at: string;
  record_name: string | null;
  case_number: string | null;
  shared_with: string;
  file_names: string;
  notes: string | null;
  timeline: string;
}

export interface TranslationRecord {
  id: number;
  staff_id: string;
  created_at: string;
  file_names: string;
  language: string;
  language_name: string;
  translation: string;
}

// ── Timeline Records ──────────────────────────────────────────────────────

export async function insertRecord(params: {
  staff_id: string;
  record_name: string | null;
  case_number?: string | null;
  file_names: string;
  notes: string | null;
  summary?: string | null;
  timeline: string;
}) {
  const result = await pool.query(
    `INSERT INTO timeline_records (staff_id, record_name, case_number, file_names, notes, summary, timeline)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [params.staff_id, params.record_name, params.case_number || null, params.file_names, params.notes, params.summary || null, params.timeline]
  );
  return { lastInsertRowid: result.rows[0].id };
}

export async function getRecordsByStaff(staffId: string) {
  const result = await pool.query(
    `SELECT id, staff_id, created_at, record_name, case_number, shared_with, file_names, notes, summary, status, tags, length(timeline) as timeline_size
     FROM timeline_records
     WHERE staff_id = $1 OR shared_with LIKE '%"' || $2 || '"%'
     ORDER BY created_at DESC`,
    [staffId, staffId]
  );
  return result.rows;
}

export async function getRecordById(id: number) {
  const result = await pool.query(`SELECT * FROM timeline_records WHERE id = $1`, [id]);
  return result.rows[0] as TimelineRecord | undefined;
}

export async function deleteRecord(id: number, staffId: string) {
  const result = await pool.query(`DELETE FROM timeline_records WHERE id = $1 AND staff_id = $2`, [id, staffId]);
  return { changes: result.rowCount };
}

export async function updateRecordSharing(sharedWith: string, id: number) {
  await pool.query(`UPDATE timeline_records SET shared_with = $1 WHERE id = $2`, [sharedWith, id]);
}

export async function updateRecordName(recordName: string, id: number) {
  await pool.query(`UPDATE timeline_records SET record_name = $1 WHERE id = $2`, [recordName, id]);
}

export async function updateRecordCase(caseNumber: string | null, id: number) {
  await pool.query(`UPDATE timeline_records SET case_number = $1 WHERE id = $2`, [caseNumber, id]);
}

// ── Audit Log ─────────────────────────────────────────────────────────────

export async function insertAuditLog(params: { staff_id: string; action: string; details: string | null }) {
  await pool.query(
    `INSERT INTO audit_log (staff_id, action, details) VALUES ($1, $2, $3)`,
    [params.staff_id, params.action, params.details]
  );
}

export async function getAuditLog(staffId: string) {
  const result = await pool.query(
    `SELECT * FROM audit_log WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [staffId]
  );
  return result.rows;
}

export async function getAuditLogAll() {
  const result = await pool.query(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200`);
  return result.rows;
}

// ── Translation Records ───────────────────────────────────────────────────

export async function insertTranslationRecord(params: {
  staff_id: string;
  record_name?: string | null;
  file_names: string;
  language: string;
  language_name: string;
  translation: string;
}) {
  const result = await pool.query(
    `INSERT INTO translation_records (staff_id, record_name, file_names, language, language_name, translation)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [params.staff_id, params.record_name || null, params.file_names, params.language, params.language_name, params.translation]
  );
  return { lastInsertRowid: result.rows[0].id };
}

export async function getTranslationsByStaff(staffId: string) {
  const result = await pool.query(
    `SELECT id, staff_id, created_at, record_name, file_names, language, language_name, status, tags
     FROM translation_records WHERE staff_id = $1 ORDER BY created_at DESC`,
    [staffId]
  );
  return result.rows;
}

export async function getTranslationById(id: number) {
  const result = await pool.query(`SELECT * FROM translation_records WHERE id = $1`, [id]);
  return result.rows[0] as TranslationRecord | undefined;
}

export async function deleteTranslation(id: number, staffId: string) {
  const result = await pool.query(`DELETE FROM translation_records WHERE id = $1 AND staff_id = $2`, [id, staffId]);
  return { changes: result.rowCount };
}

// ── Status & Tags ────────────────────────────────────────────────────────

export async function updateRecordStatus(id: number, status: string) {
  await pool.query(`UPDATE timeline_records SET status = $1 WHERE id = $2`, [status, id]);
}

export async function updateRecordTags(id: number, tags: string) {
  await pool.query(`UPDATE timeline_records SET tags = $1 WHERE id = $2`, [tags, id]);
}

export async function updateTranslationStatus(id: number, status: string) {
  await pool.query(`UPDATE translation_records SET status = $1 WHERE id = $2`, [status, id]);
}

export async function updateTranslationTags(id: number, tags: string) {
  await pool.query(`UPDATE translation_records SET tags = $1 WHERE id = $2`, [tags, id]);
}

// ── Notifications ────────────────────────────────────────────────────────

export async function insertNotification(params: { staff_id: string; message: string; link?: string }) {
  await pool.query(
    `INSERT INTO notifications (staff_id, message, link) VALUES ($1, $2, $3)`,
    [params.staff_id, params.message, params.link || null]
  );
}

export async function getNotifications(staffId: string) {
  const result = await pool.query(
    `SELECT * FROM notifications WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [staffId]
  );
  return result.rows;
}

export async function markNotificationRead(id: number, staffId: string) {
  await pool.query(`UPDATE notifications SET read = true WHERE id = $1 AND staff_id = $2`, [id, staffId]);
}

export async function markAllNotificationsRead(staffId: string) {
  await pool.query(`UPDATE notifications SET read = true WHERE staff_id = $1`, [staffId]);
}

export async function getUnreadNotificationCount(staffId: string): Promise<number> {
  const result = await pool.query(`SELECT COUNT(*) as count FROM notifications WHERE staff_id = $1 AND read = false`, [staffId]);
  return parseInt(result.rows[0].count, 10);
}

// ── Session Timeout ──────────────────────────────────────────────────────

export async function touchSession(staffId: string) {
  await pool.query(
    `INSERT INTO staff_sessions (staff_id, last_active) VALUES ($1, NOW())
     ON CONFLICT (staff_id) DO UPDATE SET last_active = NOW()`,
    [staffId]
  );
}

export async function getSessionLastActive(staffId: string): Promise<Date | null> {
  const result = await pool.query(`SELECT last_active FROM staff_sessions WHERE staff_id = $1`, [staffId]);
  return result.rows[0]?.last_active || null;
}

// ── Dashboard Stats ──────────────────────────────────────────────────────

export async function getDashboardStats(staffId: string) {
  const [timelineCount, translationCount, sharedCount, recentActivity] = await Promise.all([
    pool.query(`SELECT COUNT(*) as count FROM timeline_records WHERE staff_id = $1`, [staffId]),
    pool.query(`SELECT COUNT(*) as count FROM translation_records WHERE staff_id = $1`, [staffId]),
    pool.query(`SELECT COUNT(*) as count FROM timeline_records WHERE shared_with LIKE '%"' || $1 || '"%' AND staff_id != $1`, [staffId]),
    pool.query(`SELECT * FROM audit_log WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 5`, [staffId]),
  ]);
  return {
    timelineRecords: parseInt(timelineCount.rows[0].count, 10),
    translationRecords: parseInt(translationCount.rows[0].count, 10),
    sharedWithMe: parseInt(sharedCount.rows[0].count, 10),
    recentActivity: recentActivity.rows,
  };
}

// ── Admin ────────────────────────────────────────────────────────────────

export async function getAllRecordCounts() {
  const [timelines, translations, staff] = await Promise.all([
    pool.query(`SELECT staff_id, COUNT(*) as count FROM timeline_records GROUP BY staff_id`),
    pool.query(`SELECT staff_id, COUNT(*) as count FROM translation_records GROUP BY staff_id`),
    pool.query(`SELECT DISTINCT staff_id FROM audit_log`),
  ]);
  return { timelines: timelines.rows, translations: translations.rows, activeStaff: staff.rows.map((r: any) => r.staff_id) };
}

export default pool;
