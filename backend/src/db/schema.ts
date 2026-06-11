// Drizzle schema — the PostgreSQL target for the SQLite → Postgres migration.
//
// This is a FAITHFUL engine migration: column semantics mirror the SQLite tables
// so the application's stringify-on-write / parse-on-read contract and response
// shapes are unchanged. It still bakes in the structural review fixes that don't
// change semantics:
//   - timestamptz instead of TEXT timestamps (DB-010)
//   - real foreign keys with explicit ON DELETE cascade/restrict (DB-NEW-2)
//   - indexes on hot lookup columns (DB-008)
//   - a partial UNIQUE on respondent bar_number (DB-013)
//
// Deliberately deferred (kept faithful to SQLite for now, optimize later):
//   - JSON-bearing columns stay TEXT (app does JSON.stringify/safeJsonParse);
//     moving them to jsonb + a shared_with junction table (DB-006) is a follow-up.
//   - 0/1 flag columns stay integer (app uses 1/0); booleans are a follow-up.
//
// pgvector is enabled by the first migration for future semantic search; no
// vector column exists yet.
import {
  pgTable,
  serial,
  integer,
  text,
  real,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ── Auth / users ────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email"),
  pin: text("pin").notNull(), // scrypt hash (never plaintext)
  role: text("role").notNull().default("staff"),
  active: integer("active").notNull().default(1),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  username: text("username").notNull(),
  role: text("role").notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const staffSessions = pgTable("staff_sessions", {
  staffId: text("staff_id").primaryKey(),
  lastActive: timestamp("last_active", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    staffId: text("staff_id").notNull(),
    action: text("action").notNull(),
    details: text("details"),
    createdAt: createdAt(),
  },
  (t) => [index("idx_audit_staff").on(t.staffId)],
);

// ── Records ───────────────────────────────────────────────────────────────

export const timelineRecords = pgTable(
  "timeline_records",
  {
    id: serial("id").primaryKey(),
    staffId: text("staff_id").notNull(),
    createdAt: createdAt(),
    recordName: text("record_name"),
    caseNumber: text("case_number"),
    sharedWith: text("shared_with").default("[]"),
    fileNames: text("file_names").notNull(),
    notes: text("notes"),
    summary: text("summary"),
    status: text("status").default("draft"),
    tags: text("tags").default("[]"),
    aiScore: integer("ai_score"),
    timeline: text("timeline").notNull(),
    caseId: integer("case_id"),
    productionId: integer("production_id"),
  },
  (t) => [index("idx_timeline_staff").on(t.staffId), index("idx_timeline_status").on(t.status)],
);

// DB-006: normalized record sharing. `record_shares` is the source of truth for
// which staff a timeline record is shared with; `timeline_records.shared_with`
// (TEXT) is kept as a denormalized cache for API responses. Indexed by staff_id
// so "records shared with me" is an index lookup, not a full-table LIKE scan.
export const recordShares = pgTable(
  "record_shares",
  {
    recordId: integer("record_id")
      .notNull()
      .references(() => timelineRecords.id, { onDelete: "cascade" }),
    staffId: text("staff_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recordId, t.staffId] }),
    index("idx_record_shares_staff").on(t.staffId),
  ],
);

export const translationRecords = pgTable(
  "translation_records",
  {
    id: serial("id").primaryKey(),
    staffId: text("staff_id").notNull(),
    createdAt: createdAt(),
    recordName: text("record_name"),
    fileNames: text("file_names").notNull(),
    language: text("language").notNull(),
    languageName: text("language_name").notNull(),
    status: text("status").default("draft"),
    tags: text("tags").default("[]"),
    translation: text("translation").notNull(),
  },
  (t) => [index("idx_translation_staff").on(t.staffId)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    staffId: text("staff_id").notNull(),
    message: text("message").notNull(),
    link: text("link"),
    read: integer("read").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("idx_notifications_staff").on(t.staffId, t.read)],
);

// ── Discovery: case-lifecycle spine ─────────────────────────────────────────

export const respondentAttorneys = pgTable(
  "respondent_attorneys",
  {
    id: serial("id").primaryKey(),
    barNumber: text("bar_number"),
    name: text("name").notNull(),
    firm: text("firm"),
    email: text("email"),
    phone: text("phone"),
    barStatus: text("bar_status"),
    createdAt: createdAt(),
  },
  // DB-013: prevent duplicate respondents per bar number (allowing multiple NULLs).
  (t) => [
    uniqueIndex("uidx_respondents_bar")
      .on(t.barNumber)
      .where(sql`bar_number IS NOT NULL`),
  ],
);

export const cases = pgTable("cases", {
  id: serial("id").primaryKey(),
  docketNumber: text("docket_number").notNull().unique(),
  respondentId: integer("respondent_id").references(() => respondentAttorneys.id, {
    onDelete: "restrict",
  }),
  complainantName: text("complainant_name"),
  clientName: text("client_name"),
  matterCaption: text("matter_caption"),
  phase: text("phase").notNull().default("intake"),
  status: text("status").notNull().default("open"),
  analysisRecordId: integer("analysis_record_id"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const subpoenas = pgTable(
  "subpoenas",
  {
    id: serial("id").primaryKey(),
    caseId: integer("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    subpoenaType: text("subpoena_type").notNull().default("BOTH"),
    issuanceDate: text("issuance_date"),
    responseDeadline: text("response_deadline"),
    extendedDeadline: text("extended_deadline"),
    status: text("status").notNull().default("issued"),
    requestedItems: text("requested_items").notNull().default("[]"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("idx_subpoenas_case").on(t.caseId)],
);

export const productions = pgTable(
  "productions",
  {
    id: serial("id").primaryKey(),
    subpoenaId: integer("subpoena_id")
      .notNull()
      .references(() => subpoenas.id, { onDelete: "cascade" }),
    receivedDate: text("received_date"),
    versionNumber: integer("version_number").notNull().default(1),
    supersededBy: integer("superseded_by").references((): AnyPgColumn => productions.id),
    status: text("status").notNull().default("pending"),
    timelineRecordId: integer("timeline_record_id"),
    pageCount: integer("page_count"),
    textCharsPerPage: real("text_chars_per_page"),
    isImageOnly: integer("is_image_only"),
    ocrStatus: text("ocr_status").default("not_needed"),
    redactionStatus: text("redaction_status").default("unknown"),
    rule115Flags: text("rule115_flags"),
    followUp: text("follow_up"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("idx_productions_subpoena").on(t.subpoenaId)],
);

export const productionItems = pgTable(
  "production_items",
  {
    id: serial("id").primaryKey(),
    productionId: integer("production_id")
      .notNull()
      .references(() => productions.id, { onDelete: "cascade" }),
    itemType: text("item_type").notNull(),
    status: text("status").notNull().default("pending"),
    sourceSectionId: text("source_section_id"),
    confidence: text("confidence"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [index("idx_prod_items_production").on(t.productionId)],
);

export const productionJobs = pgTable(
  "production_jobs",
  {
    id: serial("id").primaryKey(),
    productionId: integer("production_id")
      .notNull()
      .references(() => productions.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    message: text("message"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("idx_jobs_production").on(t.productionId)],
);

// Monotonic per-year docket counter (DB-009).
export const docketSequences = pgTable("docket_sequences", {
  year: integer("year").primaryKey(),
  lastSeq: integer("last_seq").notNull().default(0),
});
