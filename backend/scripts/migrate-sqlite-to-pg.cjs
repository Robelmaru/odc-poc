// One-time data migration: legacy SQLite (backend/data/odc-poc.db) -> PostgreSQL.
// Reads with Node's built-in SQLite, writes through `pg`. Preserves original IDs
// and FK links, then resets each serial sequence. Idempotent (ON CONFLICT DO NOTHING).
//
//   node scripts/migrate-sqlite-to-pg.cjs <path-to-old.db>
//   (DATABASE_URL must point at the TARGET Postgres; run against an empty schema.)
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

const sqlitePath = process.argv[2] || "data/odc-poc.db";
const sdb = new DatabaseSync(sqlitePath, { readOnly: true });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Tables in FK-safe insert order. id-keyed tables reset their sequence afterward.
const TABLES = [
  { name: "users", cols: ["id", "username", "email", "pin", "role", "active", "created_at"], conflict: "id", serial: true },
  { name: "respondent_attorneys", cols: ["id", "bar_number", "name", "firm", "email", "phone", "bar_status", "created_at"], conflict: "id", serial: true },
  { name: "cases", cols: ["id", "docket_number", "respondent_id", "complainant_name", "client_name", "matter_caption", "phase", "status", "analysis_record_id", "created_by", "created_at", "updated_at"], conflict: "id", serial: true },
  { name: "subpoenas", cols: ["id", "case_id", "subpoena_type", "issuance_date", "response_deadline", "extended_deadline", "status", "requested_items", "created_by", "created_at", "updated_at"], conflict: "id", serial: true },
  { name: "productions", cols: ["id", "subpoena_id", "received_date", "version_number", "superseded_by", "status", "timeline_record_id", "page_count", "text_chars_per_page", "is_image_only", "ocr_status", "redaction_status", "rule115_flags", "follow_up", "notes", "created_at"], conflict: "id", serial: true, order: "id ASC" },
  { name: "production_items", cols: ["id", "production_id", "item_type", "status", "source_section_id", "confidence", "notes", "created_at"], conflict: "id", serial: true },
  { name: "production_jobs", cols: ["id", "production_id", "status", "message", "error", "created_at", "updated_at"], conflict: "id", serial: true },
  { name: "timeline_records", cols: ["id", "staff_id", "created_at", "record_name", "case_number", "shared_with", "file_names", "notes", "summary", "status", "tags", "ai_score", "timeline", "case_id", "production_id"], conflict: "id", serial: true },
  { name: "translation_records", cols: ["id", "staff_id", "created_at", "record_name", "file_names", "language", "language_name", "status", "tags", "translation"], conflict: "id", serial: true },
  { name: "notifications", cols: ["id", "staff_id", "message", "link", "read", "created_at"], conflict: "id", serial: true },
  { name: "audit_log", cols: ["id", "staff_id", "action", "details", "created_at"], conflict: "id", serial: true },
  { name: "docket_sequences", cols: ["year", "last_seq"], conflict: "year", serial: false },
];

// SQLite UTC datetime "YYYY-MM-DD HH:MM:SS" -> a UTC-marked timestamptz literal.
const DT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const conv = (v) => (typeof v === "string" && DT.test(v) ? v + "+00" : v);

function readRows(table, order) {
  try {
    return sdb.prepare(`SELECT * FROM ${table}${order ? " ORDER BY " + order : ""}`).all();
  } catch {
    return null; // table absent in old DB
  }
}

(async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const t of TABLES) {
      const rows = readRows(t.name, t.order);
      if (rows == null) {
        console.log(`${t.name}: (not in old DB, skipped)`);
        continue;
      }
      let inserted = 0;
      for (const row of rows) {
        const values = t.cols.map((c) => conv(row[c] ?? null));
        const placeholders = t.cols.map((_, i) => `$${i + 1}`).join(", ");
        const res = await client.query(
          `INSERT INTO "${t.name}" (${t.cols.map((c) => `"${c}"`).join(", ")})
           VALUES (${placeholders}) ON CONFLICT ("${t.conflict}") DO NOTHING`,
          values,
        );
        inserted += res.rowCount ?? 0;
      }
      if (t.serial) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${t.name}', 'id'),
                         GREATEST((SELECT COALESCE(MAX(id), 0) FROM "${t.name}"), 1),
                         (SELECT EXISTS(SELECT 1 FROM "${t.name}")))`,
        );
      }
      console.log(`${t.name}: ${inserted}/${rows.length} inserted`);
    }
    await client.query("COMMIT");
    console.log("Migration committed.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed (rolled back):", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
