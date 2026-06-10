-- Enable pgvector (DC Bar platform standard). No vector column exists yet;
-- this readies the DB for future semantic search / RAG over case documents.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" text NOT NULL,
	"action" text NOT NULL,
	"details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"docket_number" text NOT NULL,
	"respondent_id" integer,
	"complainant_name" text,
	"client_name" text,
	"matter_caption" text,
	"phase" text DEFAULT 'intake' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"analysis_record_id" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_docket_number_unique" UNIQUE("docket_number")
);
--> statement-breakpoint
CREATE TABLE "docket_sequences" (
	"year" integer PRIMARY KEY NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" text NOT NULL,
	"message" text NOT NULL,
	"link" text,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"production_id" integer NOT NULL,
	"item_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_section_id" text,
	"confidence" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "production_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"production_id" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"message" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "productions" (
	"id" serial PRIMARY KEY NOT NULL,
	"subpoena_id" integer NOT NULL,
	"received_date" text,
	"version_number" integer DEFAULT 1 NOT NULL,
	"superseded_by" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"timeline_record_id" integer,
	"page_count" integer,
	"text_chars_per_page" real,
	"is_image_only" boolean,
	"ocr_status" text DEFAULT 'not_needed',
	"redaction_status" text DEFAULT 'unknown',
	"rule115_flags" jsonb,
	"follow_up" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "respondent_attorneys" (
	"id" serial PRIMARY KEY NOT NULL,
	"bar_number" text,
	"name" text NOT NULL,
	"firm" text,
	"email" text,
	"phone" text,
	"bar_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"staff_id" text PRIMARY KEY NOT NULL,
	"last_active" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subpoenas" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"subpoena_type" text DEFAULT 'BOTH' NOT NULL,
	"issuance_date" text,
	"response_deadline" text,
	"extended_deadline" text,
	"status" text DEFAULT 'issued' NOT NULL,
	"requested_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"record_name" text,
	"case_number" text,
	"shared_with" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_names" jsonb NOT NULL,
	"notes" text,
	"summary" text,
	"status" text DEFAULT 'draft',
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_score" integer,
	"timeline" jsonb NOT NULL,
	"case_id" integer,
	"production_id" integer
);
--> statement-breakpoint
CREATE TABLE "translation_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"record_name" text,
	"file_names" jsonb NOT NULL,
	"language" text NOT NULL,
	"language_name" text NOT NULL,
	"status" text DEFAULT 'draft',
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"translation" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"email" text,
	"pin" text NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_respondent_id_respondent_attorneys_id_fk" FOREIGN KEY ("respondent_id") REFERENCES "public"."respondent_attorneys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_jobs" ADD CONSTRAINT "production_jobs_production_id_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_subpoena_id_subpoenas_id_fk" FOREIGN KEY ("subpoena_id") REFERENCES "public"."subpoenas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "productions" ADD CONSTRAINT "productions_superseded_by_productions_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."productions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subpoenas" ADD CONSTRAINT "subpoenas_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_staff" ON "audit_log" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_staff" ON "notifications" USING btree ("staff_id","read");--> statement-breakpoint
CREATE INDEX "idx_prod_items_production" ON "production_items" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_production" ON "production_jobs" USING btree ("production_id");--> statement-breakpoint
CREATE INDEX "idx_productions_subpoena" ON "productions" USING btree ("subpoena_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_respondents_bar" ON "respondent_attorneys" USING btree ("bar_number") WHERE bar_number IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_subpoenas_case" ON "subpoenas" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_timeline_staff" ON "timeline_records" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "idx_timeline_status" ON "timeline_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_translation_staff" ON "translation_records" USING btree ("staff_id");