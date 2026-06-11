// Core data access (PostgreSQL via the pooled `pg` client in ./client.ts).
// Schema + migrations are owned by Drizzle (src/db/schema.ts, migrations/);
// this module is queries + startup seeding only.
import { query, queryOne, execute } from "./client.js";
import { hashPin, isHashed } from "../auth/pin.js";

// ── Startup: clean expired sessions, seed default users, hash legacy PINs ────
// Runs once at import (top-level await). Assumes migrations have been applied
// (db:migrate / the deploy migration step).
async function init(): Promise<void> {
  await execute(`DELETE FROM sessions WHERE expires_at <= now()`);

  // Idempotent seed (ON CONFLICT) — safe across restarts and parallel test workers.
  const seed = `INSERT INTO users (username, pin, role, active) VALUES (?, ?, ?, 1)
                ON CONFLICT (username) DO NOTHING`;
  const count = (await queryOne<{ count: number }>(`SELECT COUNT(*)::int AS count FROM users`))!
    .count;
  if (count === 0) {
    await execute(seed, ["Caterina", hashPin("1111"), "staff"]);
    await execute(seed, ["Abesha", hashPin("2222"), "admin"]);
    await execute(seed, ["Robel", hashPin("3333"), "staff"]);
  }

  // One-time migration: hash any legacy plaintext PINs in place (idempotent).
  const rows = await query<{ id: number; pin: string }>(`SELECT id, pin FROM users`);
  for (const row of rows) {
    if (!isHashed(row.pin))
      await execute(`UPDATE users SET pin = ? WHERE id = ?`, [hashPin(row.pin), row.id]);
  }
}
await init();

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
  const row = await queryOne<{ id: number }>(
    `INSERT INTO timeline_records (staff_id, record_name, case_number, file_names, notes, summary, ai_score, timeline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      params.staff_id,
      params.record_name,
      params.case_number || null,
      params.file_names,
      params.notes,
      params.summary || null,
      params.ai_score ?? null,
      params.timeline,
    ],
  );
  return { lastInsertRowid: row!.id };
}

export async function getRecordsByStaff(staffId: string) {
  return query(
    `SELECT id, staff_id, created_at, record_name, case_number, shared_with, file_names, notes, summary, status, tags, ai_score, length(timeline)::int as timeline_size
     FROM timeline_records
     WHERE staff_id = ? OR shared_with LIKE '%"' || ? || '"%'
     ORDER BY created_at DESC`,
    [staffId, staffId],
  );
}

export async function getRecordById(id: number) {
  return queryOne<TimelineRecord>(`SELECT * FROM timeline_records WHERE id = ?`, [id]);
}

/** Batch fetch (DB-002): one query for many ids instead of N getRecordById calls. */
export async function getRecordsByIds(ids: number[]) {
  if (ids.length === 0) return [];
  return query<TimelineRecord>(`SELECT * FROM timeline_records WHERE id = ANY(?::int[])`, [ids]);
}

export async function deleteRecord(id: number, staffId: string) {
  const changes = await execute(`DELETE FROM timeline_records WHERE id = ? AND staff_id = ?`, [
    id,
    staffId,
  ]);
  return { changes };
}

export async function updateRecordSharing(sharedWith: string, id: number) {
  await execute(`UPDATE timeline_records SET shared_with = ? WHERE id = ?`, [sharedWith, id]);
}

export async function updateRecordName(recordName: string, id: number) {
  await execute(`UPDATE timeline_records SET record_name = ? WHERE id = ?`, [recordName, id]);
}

export async function updateRecordCase(caseNumber: string | null, id: number) {
  await execute(`UPDATE timeline_records SET case_number = ? WHERE id = ?`, [caseNumber, id]);
}

/** Replace the full timeline JSON of a record (formerly a raw db.prepare in the route — ARCH-001). */
export async function updateTimelineContent(id: number, timeline: string) {
  await execute(`UPDATE timeline_records SET timeline = ? WHERE id = ?`, [timeline, id]);
}

// ── Audit Log ─────────────────────────────────────────────────────────────

export async function insertAuditLog(params: {
  staff_id: string;
  action: string;
  details: string | null;
}) {
  await execute(`INSERT INTO audit_log (staff_id, action, details) VALUES (?, ?, ?)`, [
    params.staff_id,
    params.action,
    params.details,
  ]);
}

export async function getAuditLog(staffId: string) {
  return query(`SELECT * FROM audit_log WHERE staff_id = ? ORDER BY created_at DESC LIMIT 100`, [
    staffId,
  ]);
}

export async function getAuditLogAll() {
  return query(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200`);
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
  const row = await queryOne<{ id: number }>(
    `INSERT INTO translation_records (staff_id, record_name, file_names, language, language_name, translation)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      params.staff_id,
      params.record_name || null,
      params.file_names,
      params.language,
      params.language_name,
      params.translation,
    ],
  );
  return { lastInsertRowid: row!.id };
}

export async function getTranslationsByStaff(staffId: string) {
  return query(
    `SELECT id, staff_id, created_at, record_name, file_names, language, language_name, status, tags
     FROM translation_records WHERE staff_id = ? ORDER BY created_at DESC`,
    [staffId],
  );
}

export async function getTranslationById(id: number) {
  return queryOne<TranslationRecord>(`SELECT * FROM translation_records WHERE id = ?`, [id]);
}

/** Rename a translation record (formerly a raw db.prepare in the route — ARCH-001). */
export async function updateTranslationRecordName(id: number, recordName: string) {
  await execute(`UPDATE translation_records SET record_name = ? WHERE id = ?`, [recordName, id]);
}

export async function deleteTranslation(id: number, staffId: string) {
  const changes = await execute(`DELETE FROM translation_records WHERE id = ? AND staff_id = ?`, [
    id,
    staffId,
  ]);
  return { changes };
}

// ── Status & Tags ────────────────────────────────────────────────────────

export async function updateRecordStatus(id: number, status: string) {
  await execute(`UPDATE timeline_records SET status = ? WHERE id = ?`, [status, id]);
}

export async function updateRecordTags(id: number, tags: string) {
  await execute(`UPDATE timeline_records SET tags = ? WHERE id = ?`, [tags, id]);
}

export async function updateTranslationStatus(id: number, status: string) {
  await execute(`UPDATE translation_records SET status = ? WHERE id = ?`, [status, id]);
}

export async function updateTranslationTags(id: number, tags: string) {
  await execute(`UPDATE translation_records SET tags = ? WHERE id = ?`, [tags, id]);
}

// ── Notifications ────────────────────────────────────────────────────────

export async function insertNotification(params: {
  staff_id: string;
  message: string;
  link?: string;
}) {
  await execute(`INSERT INTO notifications (staff_id, message, link) VALUES (?, ?, ?)`, [
    params.staff_id,
    params.message,
    params.link || null,
  ]);
}

export async function getNotifications(staffId: string) {
  return query(`SELECT * FROM notifications WHERE staff_id = ? ORDER BY created_at DESC LIMIT 50`, [
    staffId,
  ]);
}

export async function markNotificationRead(id: number, staffId: string) {
  await execute(`UPDATE notifications SET read = 1 WHERE id = ? AND staff_id = ?`, [id, staffId]);
}

export async function markAllNotificationsRead(staffId: string) {
  await execute(`UPDATE notifications SET read = 1 WHERE staff_id = ?`, [staffId]);
}

export async function getUnreadNotificationCount(staffId: string): Promise<number> {
  const result = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM notifications WHERE staff_id = ? AND read = 0`,
    [staffId],
  );
  return result!.count;
}

// ── Session Timeout (inactivity heartbeat) ─────────────────────────────────

export async function touchSession(staffId: string) {
  await execute(
    `INSERT INTO staff_sessions (staff_id, last_active) VALUES (?, now())
     ON CONFLICT (staff_id) DO UPDATE SET last_active = now()`,
    [staffId],
  );
}

export async function getSessionLastActive(staffId: string): Promise<Date | null> {
  const result = await queryOne<{ last_active: Date }>(
    `SELECT last_active FROM staff_sessions WHERE staff_id = ?`,
    [staffId],
  );
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

export async function createSession(
  token: string,
  username: string,
  role: string,
  ttlHours: number,
) {
  await execute(
    `INSERT INTO sessions (token, username, role, expires_at)
     VALUES (?, ?, ?, now() + (? * interval '1 hour'))`,
    [token, username, role, ttlHours],
  );
}

/** Returns the session only if it exists and has not expired. */
export async function getSession(token: string): Promise<Session | undefined> {
  return queryOne<Session>(
    `SELECT token, username, role, created_at, expires_at
     FROM sessions WHERE token = ? AND expires_at > now()`,
    [token],
  );
}

export async function deleteSession(token: string) {
  await execute(`DELETE FROM sessions WHERE token = ?`, [token]);
}

// ── Dashboard Stats ──────────────────────────────────────────────────────

export async function getDashboardStats(staffId: string) {
  const timelineCount = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM timeline_records WHERE staff_id = ?`,
    [staffId],
  );
  const translationCount = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM translation_records WHERE staff_id = ?`,
    [staffId],
  );
  const sharedCount = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int as count FROM timeline_records WHERE shared_with LIKE '%"' || ? || '"%' AND staff_id != ?`,
    [staffId, staffId],
  );
  const recentActivity = await query(
    `SELECT * FROM audit_log WHERE staff_id = ? ORDER BY created_at DESC LIMIT 5`,
    [staffId],
  );
  const timelineStatuses = await query(
    `SELECT COALESCE(status, 'draft') as status, COUNT(*)::int as count FROM timeline_records WHERE staff_id = ? GROUP BY COALESCE(status, 'draft')`,
    [staffId],
  );
  const translationStatuses = await query(
    `SELECT COALESCE(status, 'draft') as status, COUNT(*)::int as count FROM translation_records WHERE staff_id = ? GROUP BY COALESCE(status, 'draft')`,
    [staffId],
  );
  // Recent 5 per status for hover previews — one windowed query per table
  // instead of one-per-status (DB-004).
  const statusNames = ["draft", "in_review", "complete", "flagged"];
  const recentPerStatus = (table: string) =>
    query<{ status: string; record_name: string | null; file_names: string }>(
      `SELECT status, record_name, file_names FROM (
         SELECT COALESCE(status, 'draft') AS status, record_name, file_names,
                ROW_NUMBER() OVER (PARTITION BY COALESCE(status, 'draft') ORDER BY created_at DESC) AS rn
         FROM ${table} WHERE staff_id = ?
       ) ranked WHERE rn <= 5`,
      [staffId],
    );
  const groupByStatus = (rows: { status: string }[]) => {
    const out: Record<string, unknown[]> = {};
    for (const s of statusNames) out[s] = [];
    for (const r of rows) (out[r.status] ??= []).push(r);
    return out;
  };
  const timelineRecent = groupByStatus(await recentPerStatus("timeline_records"));
  const translationRecent = groupByStatus(await recentPerStatus("translation_records"));
  return {
    timelineRecords: timelineCount!.count,
    translationRecords: translationCount!.count,
    sharedWithMe: sharedCount!.count,
    recentActivity,
    timelineStatuses,
    translationStatuses,
    timelineRecent,
    translationRecent,
  };
}

// ── Admin ────────────────────────────────────────────────────────────────

export async function getAllRecordCounts() {
  const timelines = await query(
    `SELECT staff_id, COUNT(*)::int as count FROM timeline_records GROUP BY staff_id`,
  );
  const translations = await query(
    `SELECT staff_id, COUNT(*)::int as count FROM translation_records GROUP BY staff_id`,
  );
  const staff = await query<{ staff_id: string }>(`SELECT DISTINCT staff_id FROM audit_log`);
  return { timelines, translations, activeStaff: staff.map((r) => r.staff_id) };
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

export async function getAllUsers(): Promise<User[]> {
  return query<User>(
    `SELECT id, username, email, pin, role, active, created_at FROM users ORDER BY username`,
  );
}

export async function getUserByUsername(username: string): Promise<User | undefined> {
  return queryOne<User>(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`, [username]);
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  return queryOne<User>(`SELECT * FROM users WHERE LOWER(email) = LOWER(?)`, [email]);
}

export async function updateUserEmail(id: number, email: string | null) {
  await execute(`UPDATE users SET email = ? WHERE id = ?`, [email, id]);
}

export async function getActiveUsernames(): Promise<string[]> {
  const rows = await query<{ username: string }>(`SELECT username FROM users WHERE active = 1`);
  return rows.map((r) => r.username);
}

export async function createUser(username: string, pin: string, role: string) {
  await execute(`INSERT INTO users (username, pin, role, active) VALUES (?, ?, ?, 1)`, [
    username,
    hashPin(pin),
    role,
  ]);
}

export async function updateUserActive(id: number, active: boolean) {
  await execute(`UPDATE users SET active = ? WHERE id = ?`, [active ? 1 : 0, id]);
}

export async function updateUserPin(id: number, pin: string) {
  await execute(`UPDATE users SET pin = ? WHERE id = ?`, [hashPin(pin), id]);
}

export async function updateUserRole(id: number, role: string) {
  await execute(`UPDATE users SET role = ? WHERE id = ?`, [role, id]);
}

/** Lightweight liveness probe for the health endpoint (OPS-008). Throws if the DB is unreachable. */
export async function pingDb(): Promise<void> {
  await queryOne(`SELECT 1`);
}
