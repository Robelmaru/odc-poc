// Drizzle schema — the PostgreSQL target for the SQLite → Postgres migration.
//
// This mirrors the current SQLite tables (database.ts + discovery.ts) but uses
// native Postgres types and bakes in the review's structural fixes:
//   - timestamptz instead of TEXT timestamps (DB-010)
//   - jsonb instead of JSON-in-TEXT columns (DB-006/DB-011 groundwork)
//   - real foreign keys with explicit ON DELETE (DB-NEW-2)
//   - indexes on hot lookup columns (DB-008)
//   - a partial UNIQUE on respondent bar_number (DB-013)
//
// The application data layer still runs on SQLite; this schema + the generated
// migrations are the foundation for the cutover (a later phase, validated
// against a real Postgres instance). pgvector is enabled by the first migration
// for future semantic search but no vector column exists yet.
import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  real,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const emptyJsonArray = sql`'[]'::jsonb`;

// ── Auth / users ────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  email: text("email"),
  pin: text("pin").notNull(), // scrypt hash (never plaintext)
  role: text("role").notNull().default("staff"),
  active: boolean("active").notNull().default(true),
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
    sharedWith: jsonb("shared_with").$type<string[]>().notNull().default(emptyJsonArray),
    fileNames: jsonb("file_names").$type<string[]>().notNull(),
    notes: text("notes"),
    summary: text("summary"),
    status: text("status").default("draft"),
    tags: jsonb("tags").$type<string[]>().notNull().default(emptyJsonArray),
    aiScore: integer("ai_score"),
    timeline: jsonb("timeline").notNull(),
    caseId: integer("case_id"),
    productionId: integer("production_id"),
  },
  (t) => [index("idx_timeline_staff").on(t.staffId), index("idx_timeline_status").on(t.status)],
);

export const translationRecords = pgTable(
  "translation_records",
  {
    id: serial("id").primaryKey(),
    staffId: text("staff_id").notNull(),
    createdAt: createdAt(),
    recordName: text("record_name"),
    fileNames: jsonb("file_names").$type<string[]>().notNull(),
    language: text("language").notNull(),
    languageName: text("language_name").notNull(),
    status: text("status").default("draft"),
    tags: jsonb("tags").$type<string[]>().notNull().default(emptyJsonArray),
    translation: jsonb("translation").notNull(),
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
    read: boolean("read").notNull().default(false),
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
    requestedItems: jsonb("requested_items")
      .$type<{ item_type: string; description: string }[]>()
      .notNull()
      .default(emptyJsonArray),
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
    isImageOnly: boolean("is_image_only"),
    ocrStatus: text("ocr_status").default("not_needed"),
    redactionStatus: text("redaction_status").default("unknown"),
    rule115Flags: jsonb("rule115_flags").$type<string[]>(),
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
