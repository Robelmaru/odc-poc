import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, "../../data/odc-poc.db");

// Ensure data directory exists
import { mkdirSync } from "fs";
import { hashPin, isHashed } from "../auth/pin.js";
mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
// SQLite ignores REFERENCES unless this is enabled per-connection (finding DB-001).
db.pragma("foreign_keys = ON");

// Create tables
db.exec(`
  -- Migrate: add missing columns to old databases
  CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY);
`);

const addColumnIfMissing = (table: string, column: string, definition: string) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!cols.find((c: any) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

// Ensure tables exist first
db.exec(`
  CREATE TABLE IF NOT EXISTS timeline_records (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id    TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
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
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id      TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    record_name   TEXT,
    file_names    TEXT    NOT NULL,
    language      TEXT    NOT NULL,
    language_name TEXT    NOT NULL,
    status        TEXT    DEFAULT 'draft',
    tags          TEXT    DEFAULT '[]',
    translation   TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id   TEXT    NOT NULL,
    message    TEXT    NOT NULL,
    link       TEXT,
    read       INTEGER DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS staff_sessions (
    staff_id    TEXT PRIMARY KEY,
    last_active TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id   TEXT    NOT NULL,
    action     TEXT    NOT NULL,
    details    TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE,
    pin        TEXT    NOT NULL,
    role       TEXT    NOT NULL DEFAULT 'staff',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Server-side session store. The cookie carries only the opaque random
  -- token; identity/role/expiry are authoritative here, never client-side.
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    role       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);

// Drop any sessions left expired from a previous run.
db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();

// Seed default users if table is empty
const userCount = (db.prepare(`SELECT COUNT(*) as count FROM users`).get() as any).count;
if (userCount === 0) {
  const insertUser = db.prepare(
    `INSERT INTO users (username, pin, role, active) VALUES (?, ?, ?, 1)`,
  );
  insertUser.run("Caterina", hashPin("1111"), "staff");
  insertUser.run("Abesha", hashPin("2222"), "admin");
  insertUser.run("Robel", hashPin("3333"), "staff");
}

// Migrate old databases that are missing newer columns
addColumnIfMissing("timeline_records", "summary", "TEXT");
addColumnIfMissing("timeline_records", "status", "TEXT DEFAULT 'draft'");
addColumnIfMissing("timeline_records", "tags", "TEXT DEFAULT '[]'");
addColumnIfMissing("timeline_records", "case_number", "TEXT");
addColumnIfMissing("translation_records", "record_name", "TEXT");
addColumnIfMissing("translation_records", "status", "TEXT DEFAULT 'draft'");
addColumnIfMissing("translation_records", "tags", "TEXT DEFAULT '[]'");
addColumnIfMissing("timeline_records", "ai_score", "INTEGER");
addColumnIfMissing("users", "email", "TEXT");

// Indexes on hot lookup columns (finding DB-008). Every user-facing request
// filters these tables by staff_id/status; without indexes each is a full scan.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_timeline_staff        ON timeline_records(staff_id);
  CREATE INDEX IF NOT EXISTS idx_timeline_status       ON timeline_records(status);
  CREATE INDEX IF NOT EXISTS idx_translation_staff     ON translation_records(staff_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_staff   ON notifications(staff_id, read);
  CREATE INDEX IF NOT EXISTS idx_audit_staff           ON audit_log(staff_id);
`);

// One-time migration: hash any legacy plaintext PINs in place (idempotent).
{
  const rows = db.prepare(`SELECT id, pin FROM users`).all() as { id: number; pin: string }[];
  const rehash = db.prepare(`UPDATE users SET pin = ? WHERE id = ?`);
  for (const row of rows) {
    if (!isHashed(row.pin)) rehash.run(hashPin(row.pin), row.id);
  }
}

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
  ai_score?: number | null;
  timeline: string;
}) {
  const result = db
    .prepare(
      `INSERT INTO timeline_records (staff_id, record_name, case_number, file_names, notes, summary, ai_score, timeline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.staff_id,
      params.record_name,
      params.case_number || null,
      params.file_names,
      params.notes,
      params.summary || null,
      params.ai_score ?? null,
      params.timeline,
    );
  return { lastInsertRowid: result.lastInsertRowid };
}

export async function getRecordsByStaff(staffId: string) {
  return db
    .prepare(
      `SELECT id, staff_id, created_at, record_name, case_number, shared_with, file_names, notes, summary, status, tags, ai_score, length(timeline) as timeline_size
     FROM timeline_records
     WHERE staff_id = ? OR shared_with LIKE '%"' || ? || '"%'
     ORDER BY created_at DESC`,
    )
    .all(staffId, staffId);
}

export async function getRecordById(id: number) {
  return db.prepare(`SELECT * FROM timeline_records WHERE id = ?`).get(id) as
    | TimelineRecord
    | undefined;
}

export async function deleteRecord(id: number, staffId: string) {
  const result = db
    .prepare(`DELETE FROM timeline_records WHERE id = ? AND staff_id = ?`)
    .run(id, staffId);
  return { changes: result.changes };
}

export async function updateRecordSharing(sharedWith: string, id: number) {
  db.prepare(`UPDATE timeline_records SET shared_with = ? WHERE id = ?`).run(sharedWith, id);
}

export async function updateRecordName(recordName: string, id: number) {
  db.prepare(`UPDATE timeline_records SET record_name = ? WHERE id = ?`).run(recordName, id);
}

export async function updateRecordCase(caseNumber: string | null, id: number) {
  db.prepare(`UPDATE timeline_records SET case_number = ? WHERE id = ?`).run(caseNumber, id);
}

// ── Audit Log ─────────────────────────────────────────────────────────────

export async function insertAuditLog(params: {
  staff_id: string;
  action: string;
  details: string | null;
}) {
  db.prepare(`INSERT INTO audit_log (staff_id, action, details) VALUES (?, ?, ?)`).run(
    params.staff_id,
    params.action,
    params.details,
  );
}

export async function getAuditLog(staffId: string) {
  return db
    .prepare(`SELECT * FROM audit_log WHERE staff_id = ? ORDER BY created_at DESC LIMIT 100`)
    .all(staffId);
}

export async function getAuditLogAll() {
  return db.prepare(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200`).all();
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
  const result = db
    .prepare(
      `INSERT INTO translation_records (staff_id, record_name, file_names, language, language_name, translation)
     VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.staff_id,
      params.record_name || null,
      params.file_names,
      params.language,
      params.language_name,
      params.translation,
    );
  return { lastInsertRowid: result.lastInsertRowid };
}

export async function getTranslationsByStaff(staffId: string) {
  return db
    .prepare(
      `SELECT id, staff_id, created_at, record_name, file_names, language, language_name, status, tags
     FROM translation_records WHERE staff_id = ? ORDER BY created_at DESC`,
    )
    .all(staffId);
}

export async function getTranslationById(id: number) {
  return db.prepare(`SELECT * FROM translation_records WHERE id = ?`).get(id) as
    | TranslationRecord
    | undefined;
}

export async function deleteTranslation(id: number, staffId: string) {
  const result = db
    .prepare(`DELETE FROM translation_records WHERE id = ? AND staff_id = ?`)
    .run(id, staffId);
  return { changes: result.changes };
}

// ── Status & Tags ────────────────────────────────────────────────────────

export async function updateRecordStatus(id: number, status: string) {
  db.prepare(`UPDATE timeline_records SET status = ? WHERE id = ?`).run(status, id);
}

export async function updateRecordTags(id: number, tags: string) {
  db.prepare(`UPDATE timeline_records SET tags = ? WHERE id = ?`).run(tags, id);
}

export async function updateTranslationStatus(id: number, status: string) {
  db.prepare(`UPDATE translation_records SET status = ? WHERE id = ?`).run(status, id);
}

export async function updateTranslationTags(id: number, tags: string) {
  db.prepare(`UPDATE translation_records SET tags = ? WHERE id = ?`).run(tags, id);
}

// ── Notifications ────────────────────────────────────────────────────────

export async function insertNotification(params: {
  staff_id: string;
  message: string;
  link?: string;
}) {
  db.prepare(`INSERT INTO notifications (staff_id, message, link) VALUES (?, ?, ?)`).run(
    params.staff_id,
    params.message,
    params.link || null,
  );
}

export async function getNotifications(staffId: string) {
  return db
    .prepare(`SELECT * FROM notifications WHERE staff_id = ? ORDER BY created_at DESC LIMIT 50`)
    .all(staffId);
}

export async function markNotificationRead(id: number, staffId: string) {
  db.prepare(`UPDATE notifications SET read = 1 WHERE id = ? AND staff_id = ?`).run(id, staffId);
}

export async function markAllNotificationsRead(staffId: string) {
  db.prepare(`UPDATE notifications SET read = 1 WHERE staff_id = ?`).run(staffId);
}

export async function getUnreadNotificationCount(staffId: string): Promise<number> {
  const result = db
    .prepare(`SELECT COUNT(*) as count FROM notifications WHERE staff_id = ? AND read = 0`)
    .get(staffId) as any;
  return result.count;
}

// ── Session Timeout ──────────────────────────────────────────────────────

export async function touchSession(staffId: string) {
  db.prepare(
    `INSERT INTO staff_sessions (staff_id, last_active) VALUES (?, datetime('now'))
     ON CONFLICT (staff_id) DO UPDATE SET last_active = datetime('now')`,
  ).run(staffId);
}

export async function getSessionLastActive(staffId: string): Promise<Date | null> {
  const result = db
    .prepare(`SELECT last_active FROM staff_sessions WHERE staff_id = ?`)
    .get(staffId) as any;
  return result?.last_active ? new Date(result.last_active) : null;
}

// ── Auth Sessions (cookie-backed) ─────────────────────────────────────────

export interface Session {
  token: string;
  username: string;
  role: string;
  created_at: string;
  expires_at: string;
}

export function createSession(token: string, username: string, role: string, ttlHours: number) {
  db.prepare(
    `INSERT INTO sessions (token, username, role, expires_at)
     VALUES (?, ?, ?, datetime('now', ?))`,
  ).run(token, username, role, `+${ttlHours} hours`);
}

/** Returns the session only if it exists and has not expired. */
export function getSession(token: string): Session | undefined {
  return db
    .prepare(
      `SELECT token, username, role, created_at, expires_at
       FROM sessions WHERE token = ? AND expires_at > datetime('now')`,
    )
    .get(token) as Session | undefined;
}

export function deleteSession(token: string) {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

// ── Dashboard Stats ──────────────────────────────────────────────────────

export async function getDashboardStats(staffId: string) {
  const timelineCount = db
    .prepare(`SELECT COUNT(*) as count FROM timeline_records WHERE staff_id = ?`)
    .get(staffId) as any;
  const translationCount = db
    .prepare(`SELECT COUNT(*) as count FROM translation_records WHERE staff_id = ?`)
    .get(staffId) as any;
  const sharedCount = db
    .prepare(
      `SELECT COUNT(*) as count FROM timeline_records WHERE shared_with LIKE '%"' || ? || '"%' AND staff_id != ?`,
    )
    .get(staffId, staffId) as any;
  const recentActivity = db
    .prepare(`SELECT * FROM audit_log WHERE staff_id = ? ORDER BY created_at DESC LIMIT 5`)
    .all(staffId);
  const timelineStatuses = db
    .prepare(
      `SELECT COALESCE(status, 'draft') as status, COUNT(*) as count FROM timeline_records WHERE staff_id = ? GROUP BY COALESCE(status, 'draft')`,
    )
    .all(staffId) as any[];
  const translationStatuses = db
    .prepare(
      `SELECT COALESCE(status, 'draft') as status, COUNT(*) as count FROM translation_records WHERE staff_id = ? GROUP BY COALESCE(status, 'draft')`,
    )
    .all(staffId) as any[];
  // Recent 5 per status for hover previews
  const statusNames = ["draft", "in_review", "complete", "flagged"];
  const timelineRecent: Record<string, any[]> = {};
  const translationRecent: Record<string, any[]> = {};
  for (const s of statusNames) {
    timelineRecent[s] = db
      .prepare(
        `SELECT record_name, file_names FROM timeline_records WHERE staff_id = ? AND COALESCE(status, 'draft') = ? ORDER BY created_at DESC LIMIT 5`,
      )
      .all(staffId, s) as any[];
    translationRecent[s] = db
      .prepare(
        `SELECT record_name, file_names FROM translation_records WHERE staff_id = ? AND COALESCE(status, 'draft') = ? ORDER BY created_at DESC LIMIT 5`,
      )
      .all(staffId, s) as any[];
  }
  return {
    timelineRecords: timelineCount.count,
    translationRecords: translationCount.count,
    sharedWithMe: sharedCount.count,
    recentActivity,
    timelineStatuses,
    translationStatuses,
    timelineRecent,
    translationRecent,
  };
}

// ── Admin ────────────────────────────────────────────────────────────────

export async function getAllRecordCounts() {
  const timelines = db
    .prepare(`SELECT staff_id, COUNT(*) as count FROM timeline_records GROUP BY staff_id`)
    .all();
  const translations = db
    .prepare(`SELECT staff_id, COUNT(*) as count FROM translation_records GROUP BY staff_id`)
    .all();
  const staff = db.prepare(`SELECT DISTINCT staff_id FROM audit_log`).all();
  return { timelines, translations, activeStaff: (staff as any[]).map((r) => r.staff_id) };
}

// ── User Management ──────────────────────────────────────────────────────

export interface User {
  id: number;
  username: string;
  email?: string | null;
  pin: string;
  role: string;
  active: number;
  created_at: string;
}

export function getAllUsers(): User[] {
  return db
    .prepare(
      `SELECT id, username, email, pin, role, active, created_at FROM users ORDER BY username`,
    )
    .all() as User[];
}

export function getUserByUsername(username: string): User | undefined {
  return db.prepare(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`).get(username) as
    | User
    | undefined;
}

export function getUserByEmail(email: string): User | undefined {
  return db.prepare(`SELECT * FROM users WHERE LOWER(email) = LOWER(?)`).get(email) as
    | User
    | undefined;
}

export function updateUserEmail(id: number, email: string) {
  db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(email, id);
}

export function getActiveUsernames(): string[] {
  return (db.prepare(`SELECT username FROM users WHERE active = 1`).all() as any[]).map(
    (r) => r.username,
  );
}

export function createUser(username: string, pin: string, role: string) {
  return db
    .prepare(`INSERT INTO users (username, pin, role, active) VALUES (?, ?, ?, 1)`)
    .run(username, hashPin(pin), role);
}

export function updateUserActive(id: number, active: boolean) {
  db.prepare(`UPDATE users SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
}

export function updateUserPin(id: number, pin: string) {
  db.prepare(`UPDATE users SET pin = ? WHERE id = ?`).run(hashPin(pin), id);
}

export function updateUserRole(id: number, role: string) {
  db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, id);
}

export default db;
