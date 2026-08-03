CREATE TABLE "record_shares" (
	"record_id" integer NOT NULL,
	"staff_id" text NOT NULL,
	CONSTRAINT "record_shares_record_id_staff_id_pk" PRIMARY KEY("record_id","staff_id")
);
--> statement-breakpoint
ALTER TABLE "record_shares" ADD CONSTRAINT "record_shares_record_id_timeline_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."timeline_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_record_shares_staff" ON "record_shares" USING btree ("staff_id");--> statement-breakpoint
-- DB-006 backfill: seed record_shares from the existing shared_with JSON arrays.
-- NULLIF guards empty strings; NULL/'' and '[]' simply expand to zero rows.
INSERT INTO "record_shares" ("record_id", "staff_id")
SELECT t.id, elem
FROM "timeline_records" t
CROSS JOIN LATERAL jsonb_array_elements_text(NULLIF(t.shared_with, '')::jsonb) AS elem
ON CONFLICT DO NOTHING;