import { Hono } from "hono";
import {
  insertRecord,
  getRecordsByStaff,
  getRecordById,
  deleteRecord,
  updateRecordSharing,
  updateRecordName,
  updateRecordCase,
  updateRecordStatus,
  updateRecordTags,
  updateTranslationStatus,
  updateTranslationTags,
  insertAuditLog,
  getAuditLog,
  getAuditLogAll,
  insertNotification,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getUnreadNotificationCount,
  touchSession,
  getDashboardStats,
  getAllRecordCounts,
  type TimelineRecord,
  insertTranslationRecord,
  getTranslationsByStaff,
  getTranslationById,
  deleteTranslation,
  type TranslationRecord,
  getUserByUsername,
  getUserByEmail,
  getActiveUsernames,
  getAllUsers,
  createUser,
  updateUserActive,
  updateUserPin,
  updateUserEmail,
  updateUserRole,
  default as db,
} from "../db/database.js";

function getValidStaff(): string[] {
  return getActiveUsernames();
}

const records = new Hono();

// PIN verification (now uses DB)
records.post("/verify", async (c) => {
  const { staff_id, pin } = await c.req.json();
  if (!staff_id || !pin) return c.json({ error: "Username and password required" }, 400);

  const user = getUserByUsername(staff_id);
  if (!user) return c.json({ error: "Invalid username or password" }, 401);
  if (!user.active) return c.json({ error: "Account is disabled. Contact your administrator." }, 403);
  if (user.pin !== pin) return c.json({ success: false, error: "Invalid username or password" }, 401);

  return c.json({ success: true, role: user.role });
});

// ── Admin: User Management ───────────────────────────────────────────────

records.get("/admin/users", async (c) => {
  const users = getAllUsers();
  return c.json({ success: true, users: users.map(u => ({ ...u, pin: '****' })) });
});

records.post("/admin/users", async (c) => {
  const { admin_id, username, email, pin, role } = await c.req.json();
  const admin = getUserByUsername(admin_id);
  if (!admin || admin.role !== 'admin') return c.json({ error: "Admin access required" }, 403);
  if (!username) return c.json({ error: "Username required" }, 400);
  if (!email && !pin) return c.json({ error: "Email (for SSO) or PIN required" }, 400);
  const existing = getUserByUsername(username);
  if (existing) return c.json({ error: "Username already exists" }, 400);
  if (email) {
    const existingByEmail = getUserByEmail(email);
    if (existingByEmail) return c.json({ error: "A user with that email already exists" }, 400);
  }
  // Use a random placeholder PIN if not provided (since SSO is the primary method)
  const userPin = pin || Math.random().toString(36).slice(2, 10);
  createUser(username, userPin, role || 'staff');
  // Set email if provided
  if (email) {
    const newUser = getUserByUsername(username);
    if (newUser) updateUserEmail(newUser.id, email);
  }
  await insertAuditLog({ staff_id: admin_id, action: 'create_user', details: `Created user "${username}"${email ? ' (' + email + ')' : ''} with role ${role || 'staff'}` });
  return c.json({ success: true });
});

records.post("/admin/users/toggle", async (c) => {
  const { admin_id, user_id, active } = await c.req.json();
  const admin = getUserByUsername(admin_id);
  if (!admin || admin.role !== 'admin') return c.json({ error: "Admin access required" }, 403);
  updateUserActive(user_id, active);
  await insertAuditLog({ staff_id: admin_id, action: active ? 'enable_user' : 'disable_user', details: `User ID ${user_id}` });
  return c.json({ success: true });
});

records.post("/admin/users/reset-pin", async (c) => {
  const { admin_id, user_id, new_pin } = await c.req.json();
  const admin = getUserByUsername(admin_id);
  if (!admin || admin.role !== 'admin') return c.json({ error: "Admin access required" }, 403);
  if (!new_pin) return c.json({ error: "New PIN required" }, 400);
  updateUserPin(user_id, new_pin);
  await insertAuditLog({ staff_id: admin_id, action: 'reset_pin', details: `Reset PIN for user ID ${user_id}` });
  return c.json({ success: true });
});

records.post("/admin/users/email", async (c) => {
  const { admin_id, user_id, email } = await c.req.json();
  const admin = getUserByUsername(admin_id);
  if (!admin || admin.role !== 'admin') return c.json({ error: "Admin access required" }, 403);
  updateUserEmail(user_id, email || null);
  await insertAuditLog({ staff_id: admin_id, action: 'set_email', details: `User ID ${user_id} email set to ${email || '(empty)'}` });
  return c.json({ success: true });
});

records.post("/admin/users/role", async (c) => {
  const { admin_id, user_id, role } = await c.req.json();
  const admin = getUserByUsername(admin_id);
  if (!admin || admin.role !== 'admin') return c.json({ error: "Admin access required" }, 403);
  if (!['staff', 'admin'].includes(role)) return c.json({ error: "Invalid role" }, 400);
  updateUserRole(user_id, role);
  await insertAuditLog({ staff_id: admin_id, action: 'change_role', details: `User ID ${user_id} role changed to ${role}` });
  return c.json({ success: true });
});

// Save a new timeline record
records.post("/", async (c) => {
  const { staff_id, record_name, case_number, file_names, notes, summary, ai_score, timeline } = await c.req.json();

  if (!staff_id || !getValidStaff().includes(staff_id)) {
    return c.json({ error: "Invalid staff member" }, 400);
  }
  if (!file_names || !timeline) {
    return c.json({ error: "file_names and timeline are required" }, 400);
  }

  const result = await insertRecord({
    staff_id,
    record_name: record_name || null,
    case_number: case_number || null,
    file_names: JSON.stringify(file_names),
    notes: notes || null,
    summary: summary || null,
    ai_score: ai_score != null ? ai_score : null,
    timeline: JSON.stringify(timeline),
  });

  await insertAuditLog({ staff_id, action: 'save_timeline', details: `Record "${record_name || file_names.join(', ')}" (ID: ${result.lastInsertRowid})` });
  return c.json({ success: true, id: result.lastInsertRowid });
});

// ── Translation Records ────────────────────────────────────────────────────
// NOTE: these must be registered BEFORE /:staffId to avoid being swallowed by it

records.post("/translations", async (c) => {
  const { staff_id, record_name, file_names, language, language_name, translation } = await c.req.json();
  if (!staff_id || !getValidStaff().includes(staff_id)) return c.json({ error: "Invalid staff member" }, 400);
  if (!file_names || !language || !translation) return c.json({ error: "file_names, language, and translation are required" }, 400);

  const result = await insertTranslationRecord({
    staff_id, record_name: record_name || null, file_names: JSON.stringify(file_names), language, language_name,
    translation: JSON.stringify(translation),
  });
  await insertAuditLog({ staff_id, action: 'save_translation', details: `"${record_name || file_names.join(', ')}" to ${language_name} (ID: ${result.lastInsertRowid})` });
  return c.json({ success: true, id: result.lastInsertRowid });
});

records.get("/translations/:staffId", async (c) => {
  const staffId = c.req.param("staffId");
  if (!getValidStaff().includes(staffId)) return c.json({ error: "Invalid staff member" }, 400);
  const rows = await getTranslationsByStaff(staffId);
  return c.json({ success: true, records: rows.map((r: any) => ({ ...r, file_names: JSON.parse(r.file_names) })) });
});

records.get("/translations/:staffId/:id", async (c) => {
  const staffId = c.req.param("staffId");
  const id = Number(c.req.param("id"));
  if (!getValidStaff().includes(staffId)) return c.json({ error: "Invalid staff member" }, 400);
  const row = await getTranslationById(id);
  if (!row || row.staff_id !== staffId) return c.json({ error: "Record not found" }, 404);
  return c.json({ success: true, record: { ...row, file_names: JSON.parse(row.file_names), translation: JSON.parse(row.translation) } });
});

records.post("/translations/rename", async (c) => {
  const { staff_id, record_id, record_name } = await c.req.json();
  if (!staff_id || !getValidStaff().includes(staff_id)) return c.json({ error: "Invalid staff member" }, 400);
  if (!record_id || !record_name) return c.json({ error: "record_id and record_name required" }, 400);
  const row = await getTranslationById(record_id);
  if (!row || row.staff_id !== staff_id) return c.json({ error: "Record not found or not yours" }, 404);
  db.prepare(`UPDATE translation_records SET record_name = ? WHERE id = ?`).run(record_name, record_id);
  return c.json({ success: true });
});

records.delete("/translations/:staffId/:id", async (c) => {
  const staffId = c.req.param("staffId");
  const id = Number(c.req.param("id"));
  if (!getValidStaff().includes(staffId)) return c.json({ error: "Invalid staff member" }, 400);
  const result = await deleteTranslation(id, staffId);
  if (result.changes === 0) return c.json({ error: "Record not found" }, 404);
  await insertAuditLog({ staff_id: staffId, action: 'delete_translation', details: `Translation ${id} deleted` });
  return c.json({ success: true });
});

// Share a record with other staff members
records.post("/share", async (c) => {
  const { staff_id, record_id, share_with } = await c.req.json();
  if (!staff_id || !getValidStaff().includes(staff_id)) return c.json({ error: "Invalid staff member" }, 400);
  if (!record_id || !share_with) return c.json({ error: "record_id and share_with are required" }, 400);

  const row = await getRecordById(record_id);
  if (!row || row.staff_id !== staff_id) return c.json({ error: "Record not found or not yours" }, 404);

  // share_with should be an array of staff names
  const validShares = share_with.filter((s: string) => getValidStaff().includes(s) && s !== staff_id);
  await updateRecordSharing(JSON.stringify(validShares), record_id);
  await insertAuditLog({ staff_id, action: 'share_record', details: `Record ${record_id} shared with ${validShares.join(', ')}` });
  // Notify each recipient
  const recordName = row.record_name || 'a timeline record';
  for (const recipient of validShares) {
    await insertNotification({ staff_id: recipient, message: `${staff_id} shared "${recordName}" with you`, link: `record:${record_id}` });
  }
  return c.json({ success: true, shared_with: validShares });
});

// Rename a record
// Update timeline content of an existing record
records.post("/update-timeline", async (c) => {
  const { staff_id, record_id, timeline } = await c.req.json();
  if (!staff_id || !getValidStaff().includes(staff_id)) return c.json({ error: "Invalid staff member" }, 400);
  if (!record_id || !timeline) return c.json({ error: "record_id and timeline required" }, 400);

  const row = await getRecordById(record_id);
  if (!row || row.staff_id !== staff_id) return c.json({ error: "Record not found or not yours" }, 404);

  db.prepare(`UPDATE timeline_records SET timeline = ? WHERE id = ?`).run(JSON.stringify(timeline), record_id);
  return c.json({ success: true });
});

records.post("/rename", async (c) => {
  const { staff_id, record_id, record_name } = await c.req.json();
  if (!staff_id || !getValidStaff().includes(staff_id)) return c.json({ error: "Invalid staff member" }, 400);
  if (!record_id || !record_name) return c.json({ error: "record_id and record_name are required" }, 400);

  const row = await getRecordById(record_id);
  if (!row || row.staff_id !== staff_id) return c.json({ error: "Record not found or not yours" }, 404);

  await updateRecordName(record_name, record_id);
  return c.json({ success: true });
});

// Update case number for a record
records.post("/case", async (c) => {
  const { staff_id, record_id, case_number } = await c.req.json();
  if (!staff_id || !getValidStaff().includes(staff_id)) return c.json({ error: "Invalid staff member" }, 400);
  if (!record_id) return c.json({ error: "record_id is required" }, 400);

  const row = await getRecordById(record_id);
  if (!row || row.staff_id !== staff_id) return c.json({ error: "Record not found or not yours" }, 404);

  await updateRecordCase(case_number || null, record_id);
  return c.json({ success: true });
});

// Merge multiple timeline records
records.post("/merge", async (c) => {
  const { staff_id, record_ids, record_name } = await c.req.json();
  if (!staff_id || !getValidStaff().includes(staff_id)) return c.json({ error: "Invalid staff member" }, 400);
  if (!record_ids || record_ids.length < 2) return c.json({ error: "Select at least 2 records to merge" }, 400);

  // Load all selected records
  const records_data: any[] = [];
  for (const id of record_ids) {
    const row = await getRecordById(id);
    if (!row || row.staff_id !== staff_id) continue;
    records_data.push({ ...row, file_names: JSON.parse(row.file_names), timeline: JSON.parse(row.timeline) });
  }

  if (records_data.length < 2) return c.json({ error: "Could not load selected records" }, 400);

  // Normalize text for fuzzy dedup: lowercase, collapse whitespace, strip punctuation
  function normalize(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Extract key words (remove common filler) for comparison
  function keyWords(s: string): Set<string> {
    const stop = new Set(['the','a','an','of','to','in','on','at','for','and','or','was','were','is','by','with','from','that','this','it','be','as','had','has','have']);
    return new Set(normalize(s).split(' ').filter(w => w.length > 2 && !stop.has(w)));
  }

  // Jaccard similarity: overlap of key words
  function wordOverlap(a: string, b: string): number {
    const wa = keyWords(a);
    const wb = keyWords(b);
    if (wa.size === 0 || wb.size === 0) return 0;
    let intersection = 0;
    for (const w of wa) { if (wb.has(w)) intersection++; }
    return intersection / Math.min(wa.size, wb.size);
  }

  function isSimilar(a: string, b: string): boolean {
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) return true;
    // Check if one contains most of the other
    const shorter = na.length < nb.length ? na : nb;
    const longer = na.length < nb.length ? nb : na;
    if (shorter.length > 15 && longer.includes(shorter.substring(0, Math.floor(shorter.length * 0.7)))) return true;
    // Check word overlap — if 60%+ of key words match, it's the same event
    if (wordOverlap(a, b) >= 0.6) return true;
    return false;
  }

  // Merge timelines: combine all events, fuzzy dedup, sort by date
  const mergedTimeline = records_data[0].timeline;
  for (let i = 1; i < records_data.length; i++) {
    const other = records_data[i].timeline;

    // Dedup documents by filename
    if (other.documents) {
      const existingFilenames = new Set((mergedTimeline.documents || []).map((d: any) => d.filename));
      for (const doc of other.documents) {
        if (!existingFilenames.has(doc.filename)) {
          mergedTimeline.documents = mergedTimeline.documents || [];
          mergedTimeline.documents.push(doc);
        }
      }
    }

    // Dedup timeline events by date + fuzzy event text
    if (other.timeline) {
      for (const evt of other.timeline) {
        const isDupe = (mergedTimeline.timeline || []).some((existing: any) =>
          existing.date === evt.date && isSimilar(existing.event, evt.event)
        );
        if (!isDupe) {
          mergedTimeline.timeline = mergedTimeline.timeline || [];
          mergedTimeline.timeline.push(evt);
        }
      }
    }

    // Dedup key dates by date + fuzzy label
    if (other.keyDates) {
      for (const kd of other.keyDates) {
        const isDupe = (mergedTimeline.keyDates || []).some((existing: any) =>
          existing.date === kd.date && isSimilar(existing.label, kd.label)
        );
        if (!isDupe) {
          mergedTimeline.keyDates = mergedTimeline.keyDates || [];
          mergedTimeline.keyDates.push(kd);
        }
      }
    }

    // Dedup conflicts by fuzzy description
    if (other.conflicts) {
      for (const c of other.conflicts) {
        const isDupe = (mergedTimeline.conflicts || []).some((existing: any) =>
          isSimilar(existing.description, c.description)
        );
        if (!isDupe) {
          mergedTimeline.conflicts = mergedTimeline.conflicts || [];
          mergedTimeline.conflicts.push(c);
        }
      }
    }

    // Dedup notes by fuzzy match
    if (other.notes) {
      for (const n of other.notes) {
        const isDupe = (mergedTimeline.notes || []).some((existing: any) => isSimilar(existing, n));
        if (!isDupe) {
          mergedTimeline.notes = mergedTimeline.notes || [];
          mergedTimeline.notes.push(n);
        }
      }
    }
  }

  // Sort timeline events by date
  if (mergedTimeline.timeline) {
    mergedTimeline.timeline.sort((a: any, b: any) => a.date.localeCompare(b.date));
  }

  // Update timeline span
  if (mergedTimeline.timeline && mergedTimeline.timeline.length > 0) {
    mergedTimeline.timelineSpan = {
      earliest: mergedTimeline.timeline[0].date,
      latest: mergedTimeline.timeline[mergedTimeline.timeline.length - 1].date,
      totalDuration: '',
    };
  }

  // Collect all file names
  const allFileNames = [...new Set(records_data.flatMap((r: any) => r.file_names))];
  const allNotes = records_data.map((r: any) => r.notes).filter(Boolean).join('; ');

  const result = await insertRecord({
    staff_id,
    record_name: record_name || `Merged: ${allFileNames.join(', ')}`,
    file_names: JSON.stringify(allFileNames),
    notes: allNotes || null,
    timeline: JSON.stringify(mergedTimeline),
  });

  return c.json({ success: true, id: result.lastInsertRowid, timeline: mergedTimeline });
});

// ── Audit Log ─────────────────────────────────────────────────────────────
records.get("/audit/:staffId", async (c) => {
  const staffId = c.req.param("staffId");
  if (!getValidStaff().includes(staffId)) return c.json({ error: "Invalid staff member" }, 400);
  const logs = await getAuditLog(staffId);
  return c.json({ success: true, logs });
});

// ── Status & Tags ────────────────────────────────────────────────────────

records.post("/status", async (c) => {
  const { staff_id, record_id, record_type, status } = await c.req.json();
  if (!staff_id || !getValidStaff().includes(staff_id)) return c.json({ error: "Invalid staff member" }, 400);
  const validStatuses = ['draft', 'in_review', 'complete', 'flagged'];
  if (!validStatuses.includes(status)) return c.json({ error: "Invalid status" }, 400);
  if (record_type === 'translation') {
    await updateTranslationStatus(record_id, status);
  } else {
    await updateRecordStatus(record_id, status);
  }
  return c.json({ success: true });
});

records.post("/tags", async (c) => {
  const { staff_id, record_id, record_type, tags } = await c.req.json();
  if (!staff_id || !getValidStaff().includes(staff_id)) return c.json({ error: "Invalid staff member" }, 400);
  if (!Array.isArray(tags)) return c.json({ error: "Tags must be an array" }, 400);
  if (record_type === 'translation') {
    await updateTranslationTags(record_id, JSON.stringify(tags));
  } else {
    await updateRecordTags(record_id, JSON.stringify(tags));
  }
  return c.json({ success: true });
});

// ── Notifications ────────────────────────────────────────────────────────

records.get("/notifications/:staffId", async (c) => {
  const staffId = c.req.param("staffId");
  if (!getValidStaff().includes(staffId)) return c.json({ error: "Invalid staff member" }, 400);
  const [notifications, unread] = await Promise.all([
    getNotifications(staffId),
    getUnreadNotificationCount(staffId),
  ]);
  return c.json({ success: true, notifications, unread });
});

records.post("/notifications/read", async (c) => {
  const { staff_id, notification_id } = await c.req.json();
  if (!staff_id || !getValidStaff().includes(staff_id)) return c.json({ error: "Invalid staff member" }, 400);
  if (notification_id === 'all') {
    await markAllNotificationsRead(staff_id);
  } else {
    await markNotificationRead(notification_id, staff_id);
  }
  return c.json({ success: true });
});

// ── Dashboard ────────────────────────────────────────────────────────────

records.get("/dashboard/:staffId", async (c) => {
  const staffId = c.req.param("staffId");
  if (!getValidStaff().includes(staffId)) return c.json({ error: "Invalid staff member" }, 400);
  const stats = await getDashboardStats(staffId);
  const unread = await getUnreadNotificationCount(staffId);
  return c.json({ success: true, ...stats, unreadNotifications: unread });
});

// ── Session Heartbeat ────────────────────────────────────────────────────

records.post("/heartbeat", async (c) => {
  const { staff_id } = await c.req.json();
  if (!staff_id || !getValidStaff().includes(staff_id)) return c.json({ error: "Invalid" }, 400);
  await touchSession(staff_id);
  return c.json({ success: true });
});

// ── Admin ────────────────────────────────────────────────────────────────

records.get("/admin/overview", async (c) => {
  const counts = await getAllRecordCounts();
  const allLogs = await getAuditLogAll();
  return c.json({ success: true, ...counts, recentActivity: allLogs });
});

// ── Timeline Records ────────────────────────────────────────────────────────

// Get all records for a staff member (without full timeline to keep response small)
records.get("/:staffId", async (c) => {
  const staffId = c.req.param("staffId");

  if (!getValidStaff().includes(staffId)) {
    return c.json({ error: "Invalid staff member" }, 400);
  }

  const rows = await getRecordsByStaff(staffId);
  const parsed = rows.map((r: any) => ({
    ...r,
    file_names: JSON.parse(r.file_names),
    shared_with: JSON.parse(r.shared_with || '[]'),
  }));

  return c.json({ success: true, records: parsed });
});

// Get a single full record by ID
records.get("/:staffId/:id", async (c) => {
  const staffId = c.req.param("staffId");
  const id = Number(c.req.param("id"));

  if (!getValidStaff().includes(staffId)) {
    return c.json({ error: "Invalid staff member" }, 400);
  }

  const row = await getRecordById(id);
  if (!row) {
    return c.json({ error: "Record not found" }, 404);
  }
  const sharedWith: string[] = JSON.parse(row.shared_with || '[]');
  if (row.staff_id !== staffId && !sharedWith.includes(staffId)) {
    return c.json({ error: "Record not found" }, 404);
  }

  return c.json({
    success: true,
    record: {
      ...row,
      file_names: JSON.parse(row.file_names),
      timeline: JSON.parse(row.timeline),
    },
  });
});

// Delete a record
records.delete("/:staffId/:id", async (c) => {
  const staffId = c.req.param("staffId");
  const id = Number(c.req.param("id"));

  if (!getValidStaff().includes(staffId)) {
    return c.json({ error: "Invalid staff member" }, 400);
  }

  const result = await deleteRecord(id, staffId);
  if (result.changes === 0) {
    return c.json({ error: "Record not found" }, 404);
  }

  await insertAuditLog({ staff_id: staffId, action: 'delete_record', details: `Record ${id} deleted` });
  return c.json({ success: true });
});

export { getValidStaff };
export default records;
