import type { FastifyInstance } from "fastify";
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
  insertTranslationRecord,
  getTranslationsByStaff,
  getTranslationById,
  deleteTranslation,
  getUserByUsername,
  getUserByEmail,
  getActiveUsernames,
  getAllUsers,
  createUser,
  updateUserActive,
  updateUserPin,
  updateUserEmail,
  updateUserRole,
  updateTranslationRecordName,
  updateTimelineContent,
} from "../db/database.js";
import { issueSession, authUser } from "../auth/session.js";
import { verifyPin } from "../auth/pin.js";
import { safeJsonParse } from "../utils/json.js";
import { isSimilar } from "../utils/textSimilarity.js";

const tags = { tags: ["records"] };
type Body = Record<string, unknown>;

export default async function records(app: FastifyInstance) {
  // PIN verification (public — sets the session cookie). Rate-limited against
  // brute force: 10 attempts / 5 min / IP (SEC-014, via @fastify/rate-limit).
  app.post(
    "/verify",
    { schema: tags, config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      const { staff_id, pin } = (request.body ?? {}) as { staff_id?: string; pin?: string };
      if (!staff_id || !pin)
        return reply.code(400).send({ error: "Username and password required" });
      const user = await getUserByUsername(staff_id);
      if (!user) return reply.code(401).send({ error: "Invalid username or password" });
      if (!user.active)
        return reply.code(403).send({ error: "Account is disabled. Contact your administrator." });
      if (!verifyPin(pin, user.pin))
        return reply.code(401).send({ success: false, error: "Invalid username or password" });
      await issueSession(reply, { username: user.username, role: user.role });
      return { success: true, role: user.role };
    },
  );

  // ── Admin: User Management ───────────────────────────────────────────────
  app.get("/admin/users", { schema: tags }, async (request, reply) => {
    if (authUser(request).role !== "admin")
      return reply.code(403).send({ error: "Admin access required" });
    const users = await getAllUsers();
    return { success: true, users: users.map((u) => ({ ...u, pin: "****" })) };
  });

  app.post("/admin/users", { schema: tags }, async (request, reply) => {
    const { username, email, pin, role } = (request.body ?? {}) as Body & {
      username?: string;
      email?: string;
      pin?: string;
      role?: string;
    };
    const admin = authUser(request);
    if (admin.role !== "admin") return reply.code(403).send({ error: "Admin access required" });
    if (!username) return reply.code(400).send({ error: "Username required" });
    if (!email && !pin) return reply.code(400).send({ error: "Email (for SSO) or PIN required" });
    if (await getUserByUsername(username))
      return reply.code(400).send({ error: "Username already exists" });
    if (email && (await getUserByEmail(email)))
      return reply.code(400).send({ error: "A user with that email already exists" });
    const userPin = pin || Math.random().toString(36).slice(2, 10);
    await createUser(username, userPin, role || "staff");
    if (email) {
      const newUser = await getUserByUsername(username);
      if (newUser) await updateUserEmail(newUser.id, email);
    }
    await insertAuditLog({
      staff_id: admin.username,
      action: "create_user",
      details: `Created user "${username}"${email ? " (" + email + ")" : ""} with role ${role || "staff"}`,
    });
    return { success: true };
  });

  app.post("/admin/users/toggle", { schema: tags }, async (request, reply) => {
    const { user_id, active } = (request.body ?? {}) as { user_id?: number; active?: boolean };
    const admin = authUser(request);
    if (admin.role !== "admin") return reply.code(403).send({ error: "Admin access required" });
    await updateUserActive(Number(user_id), !!active);
    await insertAuditLog({
      staff_id: admin.username,
      action: active ? "enable_user" : "disable_user",
      details: `User ID ${user_id}`,
    });
    return { success: true };
  });

  app.post("/admin/users/reset-pin", { schema: tags }, async (request, reply) => {
    const { user_id, new_pin } = (request.body ?? {}) as { user_id?: number; new_pin?: string };
    const admin = authUser(request);
    if (admin.role !== "admin") return reply.code(403).send({ error: "Admin access required" });
    if (!new_pin) return reply.code(400).send({ error: "New PIN required" });
    await updateUserPin(Number(user_id), new_pin);
    await insertAuditLog({
      staff_id: admin.username,
      action: "reset_pin",
      details: `Reset PIN for user ID ${user_id}`,
    });
    return { success: true };
  });

  app.post("/admin/users/email", { schema: tags }, async (request, reply) => {
    const { user_id, email } = (request.body ?? {}) as { user_id?: number; email?: string };
    const admin = authUser(request);
    if (admin.role !== "admin") return reply.code(403).send({ error: "Admin access required" });
    await updateUserEmail(Number(user_id), email || null);
    await insertAuditLog({
      staff_id: admin.username,
      action: "set_email",
      details: `User ID ${user_id} email set to ${email || "(empty)"}`,
    });
    return { success: true };
  });

  app.post("/admin/users/role", { schema: tags }, async (request, reply) => {
    const { user_id, role } = (request.body ?? {}) as { user_id?: number; role?: string };
    const admin = authUser(request);
    if (admin.role !== "admin") return reply.code(403).send({ error: "Admin access required" });
    if (!role || !["staff", "admin"].includes(role))
      return reply.code(400).send({ error: "Invalid role" });
    await updateUserRole(Number(user_id), role);
    await insertAuditLog({
      staff_id: admin.username,
      action: "change_role",
      details: `User ID ${user_id} role changed to ${role}`,
    });
    return { success: true };
  });

  // Save a new timeline record
  app.post("/", { schema: tags }, async (request, reply) => {
    const me = authUser(request).username;
    const { record_name, case_number, file_names, notes, summary, ai_score, timeline } =
      (request.body ?? {}) as Body & { file_names?: string[]; record_name?: string };
    if (!file_names || !timeline)
      return reply.code(400).send({ error: "file_names and timeline are required" });
    const result = await insertRecord({
      staff_id: me,
      record_name: record_name || null,
      case_number: (case_number as string) || null,
      file_names: JSON.stringify(file_names),
      notes: (notes as string) || null,
      summary: (summary as string) || null,
      ai_score: ai_score != null ? (ai_score as number) : null,
      timeline: JSON.stringify(timeline),
    });
    await insertAuditLog({
      staff_id: me,
      action: "save_timeline",
      details: `Record "${record_name || file_names.join(", ")}" (ID: ${result.lastInsertRowid})`,
    });
    return { success: true, id: result.lastInsertRowid };
  });

  // ── Translation Records (registered before /:staffId) ──────────────────────
  app.post("/translations", { schema: tags }, async (request, reply) => {
    const me = authUser(request).username;
    const { record_name, file_names, language, language_name, translation } = (request.body ??
      {}) as Body & { file_names?: string[]; language?: string; record_name?: string };
    if (!file_names || !language || !translation)
      return reply.code(400).send({ error: "file_names, language, and translation are required" });
    const result = await insertTranslationRecord({
      staff_id: me,
      record_name: record_name || null,
      file_names: JSON.stringify(file_names),
      language,
      language_name: language_name as string,
      translation: JSON.stringify(translation),
    });
    await insertAuditLog({
      staff_id: me,
      action: "save_translation",
      details: `"${record_name || file_names.join(", ")}" to ${language_name} (ID: ${result.lastInsertRowid})`,
    });
    return { success: true, id: result.lastInsertRowid };
  });

  app.get("/translations/:staffId", { schema: tags }, async (request) => {
    const staffId = authUser(request).username;
    const rows = await getTranslationsByStaff(staffId);
    return {
      success: true,
      records: rows.map((r: Record<string, unknown>) => ({
        ...r,
        file_names: safeJsonParse(r.file_names as string, []),
      })),
    };
  });

  app.get("/translations/:staffId/:id", { schema: tags }, async (request, reply) => {
    const staffId = authUser(request).username;
    const id = Number((request.params as { id: string }).id);
    const row = await getTranslationById(id);
    if (!row || row.staff_id !== staffId)
      return reply.code(404).send({ error: "Record not found" });
    return {
      success: true,
      record: {
        ...row,
        file_names: safeJsonParse(row.file_names, []),
        translation: safeJsonParse(row.translation, {}),
      },
    };
  });

  app.post("/translations/rename", { schema: tags }, async (request, reply) => {
    const me = authUser(request).username;
    const { record_id, record_name } = (request.body ?? {}) as {
      record_id?: number;
      record_name?: string;
    };
    if (!record_id || !record_name)
      return reply.code(400).send({ error: "record_id and record_name required" });
    const row = await getTranslationById(record_id);
    if (!row || row.staff_id !== me)
      return reply.code(404).send({ error: "Record not found or not yours" });
    await updateTranslationRecordName(record_id, record_name);
    return { success: true };
  });

  app.delete("/translations/:staffId/:id", { schema: tags }, async (request, reply) => {
    const staffId = authUser(request).username;
    const id = Number((request.params as { id: string }).id);
    const result = await deleteTranslation(id, staffId);
    if (result.changes === 0) return reply.code(404).send({ error: "Record not found" });
    await insertAuditLog({
      staff_id: staffId,
      action: "delete_translation",
      details: `Translation ${id} deleted`,
    });
    return { success: true };
  });

  // Share a record with other staff members
  app.post("/share", { schema: tags }, async (request, reply) => {
    const me = authUser(request).username;
    const { record_id, share_with } = (request.body ?? {}) as {
      record_id?: number;
      share_with?: string[];
    };
    if (!record_id || !share_with)
      return reply.code(400).send({ error: "record_id and share_with are required" });
    const row = await getRecordById(record_id);
    if (!row || row.staff_id !== me)
      return reply.code(404).send({ error: "Record not found or not yours" });
    const activeStaff = await getActiveUsernames();
    const validShares = share_with.filter((s: string) => activeStaff.includes(s) && s !== me);
    await updateRecordSharing(JSON.stringify(validShares), record_id);
    await insertAuditLog({
      staff_id: me,
      action: "share_record",
      details: `Record ${record_id} shared with ${validShares.join(", ")}`,
    });
    const recordName = row.record_name || "a timeline record";
    for (const recipient of validShares) {
      await insertNotification({
        staff_id: recipient,
        message: `${me} shared "${recordName}" with you`,
        link: `record:${record_id}`,
      });
    }
    return { success: true, shared_with: validShares };
  });

  // Update timeline content of an existing record
  app.post("/update-timeline", { schema: tags }, async (request, reply) => {
    const me = authUser(request).username;
    const { record_id, timeline } = (request.body ?? {}) as {
      record_id?: number;
      timeline?: unknown;
    };
    if (!record_id || !timeline)
      return reply.code(400).send({ error: "record_id and timeline required" });
    const row = await getRecordById(record_id);
    if (!row || row.staff_id !== me)
      return reply.code(404).send({ error: "Record not found or not yours" });
    await updateTimelineContent(record_id, JSON.stringify(timeline));
    return { success: true };
  });

  app.post("/rename", { schema: tags }, async (request, reply) => {
    const me = authUser(request).username;
    const { record_id, record_name } = (request.body ?? {}) as {
      record_id?: number;
      record_name?: string;
    };
    if (!record_id || !record_name)
      return reply.code(400).send({ error: "record_id and record_name are required" });
    const row = await getRecordById(record_id);
    if (!row || row.staff_id !== me)
      return reply.code(404).send({ error: "Record not found or not yours" });
    await updateRecordName(record_name, record_id);
    return { success: true };
  });

  // Update case number for a record
  app.post("/case", { schema: tags }, async (request, reply) => {
    const me = authUser(request).username;
    const { record_id, case_number } = (request.body ?? {}) as {
      record_id?: number;
      case_number?: string;
    };
    if (!record_id) return reply.code(400).send({ error: "record_id is required" });
    const row = await getRecordById(record_id);
    if (!row || row.staff_id !== me)
      return reply.code(404).send({ error: "Record not found or not yours" });
    await updateRecordCase(case_number || null, record_id);
    return { success: true };
  });

  // Merge multiple timeline records
  app.post("/merge", { schema: tags }, async (request, reply) => {
    const me = authUser(request).username;
    const { record_ids, record_name } = (request.body ?? {}) as {
      record_ids?: number[];
      record_name?: string;
    };
    if (!record_ids || record_ids.length < 2)
      return reply.code(400).send({ error: "Select at least 2 records to merge" });

    const records_data: Record<string, any>[] = [];
    for (const id of record_ids) {
      const row = await getRecordById(id);
      if (!row || row.staff_id !== me) continue;
      records_data.push({
        ...row,
        file_names: safeJsonParse(row.file_names, []),
        timeline: safeJsonParse(row.timeline, {}),
      });
    }
    if (records_data.length < 2)
      return reply.code(400).send({ error: "Could not load selected records" });

    // Merge timelines: combine all events, fuzzy dedup (isSimilar), sort by date
    const mergedTimeline = records_data[0]!.timeline;
    for (let i = 1; i < records_data.length; i++) {
      const other = records_data[i]!.timeline;
      if (other.documents) {
        const existingFilenames = new Set(
          (mergedTimeline.documents || []).map((d: any) => d.filename),
        );
        for (const doc of other.documents) {
          if (!existingFilenames.has(doc.filename)) {
            mergedTimeline.documents = mergedTimeline.documents || [];
            mergedTimeline.documents.push(doc);
          }
        }
      }
      if (other.timeline) {
        for (const evt of other.timeline) {
          const isDupe = (mergedTimeline.timeline || []).some(
            (existing: any) => existing.date === evt.date && isSimilar(existing.event, evt.event),
          );
          if (!isDupe) {
            mergedTimeline.timeline = mergedTimeline.timeline || [];
            mergedTimeline.timeline.push(evt);
          }
        }
      }
      if (other.keyDates) {
        for (const kd of other.keyDates) {
          const isDupe = (mergedTimeline.keyDates || []).some(
            (existing: any) => existing.date === kd.date && isSimilar(existing.label, kd.label),
          );
          if (!isDupe) {
            mergedTimeline.keyDates = mergedTimeline.keyDates || [];
            mergedTimeline.keyDates.push(kd);
          }
        }
      }
      if (other.conflicts) {
        for (const conflict of other.conflicts) {
          const isDupe = (mergedTimeline.conflicts || []).some((existing: any) =>
            isSimilar(existing.description, conflict.description),
          );
          if (!isDupe) {
            mergedTimeline.conflicts = mergedTimeline.conflicts || [];
            mergedTimeline.conflicts.push(conflict);
          }
        }
      }
      if (other.notes) {
        for (const n of other.notes) {
          const isDupe = (mergedTimeline.notes || []).some((existing: any) =>
            isSimilar(existing, n),
          );
          if (!isDupe) {
            mergedTimeline.notes = mergedTimeline.notes || [];
            mergedTimeline.notes.push(n);
          }
        }
      }
    }

    if (mergedTimeline.timeline) {
      mergedTimeline.timeline.sort((a: any, b: any) => a.date.localeCompare(b.date));
    }
    if (mergedTimeline.timeline && mergedTimeline.timeline.length > 0) {
      mergedTimeline.timelineSpan = {
        earliest: mergedTimeline.timeline[0].date,
        latest: mergedTimeline.timeline[mergedTimeline.timeline.length - 1].date,
        totalDuration: "",
      };
    }

    const allFileNames = [...new Set(records_data.flatMap((r) => r.file_names))];
    const allNotes = records_data
      .map((r) => r.notes)
      .filter(Boolean)
      .join("; ");

    const result = await insertRecord({
      staff_id: me,
      record_name: record_name || `Merged: ${allFileNames.join(", ")}`,
      file_names: JSON.stringify(allFileNames),
      notes: allNotes || null,
      timeline: JSON.stringify(mergedTimeline),
    });
    return { success: true, id: result.lastInsertRowid, timeline: mergedTimeline };
  });

  // ── Audit Log ─────────────────────────────────────────────────────────────
  app.get("/audit/:staffId", { schema: tags }, async (request) => {
    return { success: true, logs: await getAuditLog(authUser(request).username) };
  });

  // ── Status & Tags ────────────────────────────────────────────────────────
  app.post("/status", { schema: tags }, async (request, reply) => {
    const { record_id, record_type, status } = (request.body ?? {}) as {
      record_id?: number;
      record_type?: string;
      status?: string;
    };
    const validStatuses = ["draft", "in_review", "complete", "flagged"];
    if (!status || !validStatuses.includes(status))
      return reply.code(400).send({ error: "Invalid status" });
    if (record_type === "translation") await updateTranslationStatus(Number(record_id), status);
    else await updateRecordStatus(Number(record_id), status);
    return { success: true };
  });

  app.post("/tags", { schema: tags }, async (request, reply) => {
    const {
      record_id,
      record_type,
      tags: t,
    } = (request.body ?? {}) as {
      record_id?: number;
      record_type?: string;
      tags?: unknown;
    };
    if (!Array.isArray(t)) return reply.code(400).send({ error: "Tags must be an array" });
    if (record_type === "translation")
      await updateTranslationTags(Number(record_id), JSON.stringify(t));
    else await updateRecordTags(Number(record_id), JSON.stringify(t));
    return { success: true };
  });

  // ── Notifications ────────────────────────────────────────────────────────
  app.get("/notifications/:staffId", { schema: tags }, async (request) => {
    const staffId = authUser(request).username;
    const [notifications, unread] = await Promise.all([
      getNotifications(staffId),
      getUnreadNotificationCount(staffId),
    ]);
    return { success: true, notifications, unread };
  });

  app.post("/notifications/read", { schema: tags }, async (request) => {
    const me = authUser(request).username;
    const { notification_id } = (request.body ?? {}) as { notification_id?: number | "all" };
    if (notification_id === "all") await markAllNotificationsRead(me);
    else await markNotificationRead(Number(notification_id), me);
    return { success: true };
  });

  // ── Dashboard ────────────────────────────────────────────────────────────
  app.get("/dashboard/:staffId", { schema: tags }, async (request) => {
    const staffId = authUser(request).username;
    const stats = await getDashboardStats(staffId);
    const unread = await getUnreadNotificationCount(staffId);
    return { success: true, ...stats, unreadNotifications: unread };
  });

  // ── Session heartbeat ──────────────────────────────────────────────────────
  app.post("/heartbeat", { schema: tags }, async (request) => {
    await touchSession(authUser(request).username);
    return { success: true };
  });

  // ── Admin overview ──────────────────────────────────────────────────────────
  app.get("/admin/overview", { schema: tags }, async (request, reply) => {
    if (authUser(request).role !== "admin")
      return reply.code(403).send({ error: "Admin access required" });
    const counts = await getAllRecordCounts();
    const allLogs = await getAuditLogAll();
    return { success: true, ...counts, recentActivity: allLogs };
  });

  // ── Timeline records (catch-all params; registered last) ──────────────────
  app.get("/:staffId", { schema: tags }, async (request) => {
    const staffId = authUser(request).username;
    const rows = await getRecordsByStaff(staffId);
    return {
      success: true,
      records: rows.map((r: Record<string, unknown>) => ({
        ...r,
        file_names: safeJsonParse(r.file_names as string, []),
        shared_with: safeJsonParse(r.shared_with as string, []),
      })),
    };
  });

  app.get("/:staffId/:id", { schema: tags }, async (request, reply) => {
    const staffId = authUser(request).username;
    const id = Number((request.params as { id: string }).id);
    const row = await getRecordById(id);
    if (!row) return reply.code(404).send({ error: "Record not found" });
    const sharedWith: string[] = safeJsonParse(row.shared_with, []);
    if (row.staff_id !== staffId && !sharedWith.includes(staffId))
      return reply.code(404).send({ error: "Record not found" });
    return {
      success: true,
      record: {
        ...row,
        file_names: safeJsonParse(row.file_names, []),
        timeline: safeJsonParse(row.timeline, {}),
      },
    };
  });

  app.delete("/:staffId/:id", { schema: tags }, async (request, reply) => {
    const staffId = authUser(request).username;
    const id = Number((request.params as { id: string }).id);
    const result = await deleteRecord(id, staffId);
    if (result.changes === 0) return reply.code(404).send({ error: "Record not found" });
    await insertAuditLog({
      staff_id: staffId,
      action: "delete_record",
      details: `Record ${id} deleted`,
    });
    return { success: true };
  });
}
