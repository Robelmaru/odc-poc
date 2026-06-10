import { Hono } from "hono";
import { insertAuditLog, getRecordById } from "../db/database.js";
import {
  createRespondent,
  listRespondents,
  createCase,
  getCase,
  listCases,
  updateCasePhase,
  updateCaseStatus,
  deleteCase,
  deleteProduction,
  createSubpoena,
  getSubpoena,
  listSubpoenasByCase,
  updateSubpoenaStatus,
  extendSubpoenaDeadline,
  getOverdueSubpoenas,
  createProduction,
  getProduction,
  listProductionsBySubpoena,
  updateProductionIntake,
  getProductionItems,
  getLatestProductionJob,
} from "../db/discovery.js";
import {
  reconcileProductionContent,
  startProductionProcessing,
} from "../utils/productionProcessor.js";
import {
  SUBPOENA_CHECKLIST,
  defaultRequestedItems,
  checklistForBucket,
  type ChecklistBucket,
} from "../knowledge/subpoenaChecklist.js";
import { type AppEnv } from "../auth/session.js";
import { safeJsonParse } from "../utils/json.js";

const discovery = new Hono<AppEnv>();

// ── Checklist (UI seed) ─────────────────────────────────────────────────────

discovery.get("/checklist", (c) => c.json({ success: true, checklist: SUBPOENA_CHECKLIST }));

// ── Respondent attorneys ────────────────────────────────────────────────────

discovery.post("/respondents", async (c) => {
  const me = c.get("user").username;
  const { name, bar_number, firm, email, phone } = await c.req.json();
  if (!name) return c.json({ error: "name is required" }, 400);
  const r = createRespondent({ name, bar_number, firm, email, phone });
  await insertAuditLog({
    staff_id: me,
    action: "create_respondent",
    details: `${name} (ID ${r.id})`,
  });
  return c.json({ success: true, id: r.id });
});

discovery.get("/respondents", (c) => c.json({ success: true, respondents: listRespondents() }));

// ── Cases ────────────────────────────────────────────────────────────────────

discovery.post("/cases", async (c) => {
  const me = c.get("user").username;
  const body = await c.req.json();
  const { respondent_id, complainant_name, client_name, matter_caption, analysis_record_id } = body;
  const year = Number(body.year) || new Date().getFullYear();
  const r = createCase({
    year,
    respondent_id: respondent_id ?? null,
    complainant_name: complainant_name ?? null,
    client_name: client_name ?? null,
    matter_caption: matter_caption ?? null,
    analysis_record_id: analysis_record_id ?? null,
    created_by: me,
  });
  await insertAuditLog({
    staff_id: me,
    action: "create_case",
    details: `${r.docket_number} (ID ${r.id})`,
  });
  return c.json({ success: true, id: r.id, docket_number: r.docket_number });
});

discovery.get("/cases", (c) => c.json({ success: true, cases: listCases() }));

discovery.get("/cases/:id", (c) => {
  const id = Number(c.req.param("id"));
  const caseRow = getCase(id);
  if (!caseRow) return c.json({ error: "Case not found" }, 404);
  const subpoenas = listSubpoenasByCase(id).map((s) => ({
    ...s,
    requested_items: safeJsonParse(s.requested_items, []),
    productions: listProductionsBySubpoena(s.id).map((p) => ({
      ...p,
      items: getProductionItems(p.id),
    })),
  }));
  return c.json({ success: true, case: caseRow, subpoenas });
});

discovery.post("/cases/:id/phase", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("user").username;
  const { phase } = await c.req.json();
  if (!getCase(id)) return c.json({ error: "Case not found" }, 404);
  if (!updateCasePhase(id, phase)) return c.json({ error: "Invalid phase" }, 400);
  await insertAuditLog({ staff_id: me, action: "case_phase", details: `Case ${id} -> ${phase}` });
  return c.json({ success: true });
});

discovery.post("/cases/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("user").username;
  const { status } = await c.req.json();
  if (!getCase(id)) return c.json({ error: "Case not found" }, 404);
  if (!updateCaseStatus(id, status)) return c.json({ error: "Invalid status" }, 400);
  await insertAuditLog({ staff_id: me, action: "case_status", details: `Case ${id} -> ${status}` });
  return c.json({ success: true });
});

// Delete a docket/case and everything under it (cascade). staff_id via query.
discovery.delete("/cases/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("user").username;
  const caseRow = getCase(id);
  if (!caseRow) return c.json({ error: "Case not found" }, 404);
  const result = deleteCase(id);
  await insertAuditLog({
    staff_id: me,
    action: "delete_case",
    details: `Deleted ${caseRow.docket_number} (ID ${id}) and all subpoenas/productions`,
  });
  return c.json({ success: true, changes: result.changes });
});

// ── Subpoenas ─────────────────────────────────────────────────────────────

discovery.post("/cases/:id/subpoenas", async (c) => {
  const caseId = Number(c.req.param("id"));
  const me = c.get("user").username;
  const body = await c.req.json();
  const { issuance_date, response_deadline } = body;
  if (!getCase(caseId)) return c.json({ error: "Case not found" }, 404);

  const subpoena_type: string = body.subpoena_type || "BOTH";
  // Seed requested_items from the standard checklist based on subpoena type,
  // unless the caller supplied an explicit list.
  let requested_items: { item_type: string; description: string }[];
  if (Array.isArray(body.requested_items) && body.requested_items.length > 0) {
    requested_items = body.requested_items;
  } else if (subpoena_type === "CLIENT_FILE") {
    requested_items = checklistForBucket("office_file" as ChecklistBucket).map((i) => ({
      item_type: i.id,
      description: i.label,
    }));
  } else if (subpoena_type === "FINANCIAL_RECORDS") {
    requested_items = checklistForBucket("financial_records" as ChecklistBucket).map((i) => ({
      item_type: i.id,
      description: i.label,
    }));
  } else {
    requested_items = defaultRequestedItems();
  }

  const r = createSubpoena({
    case_id: caseId,
    subpoena_type,
    issuance_date: issuance_date ?? null,
    response_deadline: response_deadline ?? null,
    requested_items,
    created_by: me,
  });
  await insertAuditLog({
    staff_id: me,
    action: "create_subpoena",
    details: `Subpoena ${r.id} (${subpoena_type}) on case ${caseId}, due ${response_deadline ?? "n/a"}`,
  });
  return c.json({ success: true, id: r.id, requested_items });
});

discovery.get("/subpoenas/:id", (c) => {
  const id = Number(c.req.param("id"));
  const s = getSubpoena(id);
  if (!s) return c.json({ error: "Subpoena not found" }, 404);
  return c.json({
    success: true,
    subpoena: { ...s, requested_items: safeJsonParse(s.requested_items, []) },
    productions: listProductionsBySubpoena(id).map((p) => ({
      ...p,
      items: getProductionItems(p.id),
    })),
  });
});

discovery.post("/subpoenas/:id/status", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("user").username;
  const { status } = await c.req.json();
  if (!getSubpoena(id)) return c.json({ error: "Subpoena not found" }, 404);
  if (!updateSubpoenaStatus(id, status)) return c.json({ error: "Invalid status" }, 400);
  await insertAuditLog({
    staff_id: me,
    action: "subpoena_status",
    details: `Subpoena ${id} -> ${status}`,
  });
  return c.json({ success: true });
});

discovery.post("/subpoenas/:id/extend", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("user").username;
  const { extended_deadline, reason } = await c.req.json();
  if (!getSubpoena(id)) return c.json({ error: "Subpoena not found" }, 404);
  if (!extended_deadline) return c.json({ error: "extended_deadline is required" }, 400);
  extendSubpoenaDeadline(id, extended_deadline);
  await insertAuditLog({
    staff_id: me,
    action: "subpoena_extend",
    details: `Subpoena ${id} extended to ${extended_deadline}${reason ? " — " + reason : ""}`,
  });
  return c.json({ success: true });
});

// ── Productions ─────────────────────────────────────────────────────────────

discovery.post("/subpoenas/:id/productions", async (c) => {
  const subpoenaId = Number(c.req.param("id"));
  const me = c.get("user").username;
  const body = await c.req.json();
  const { received_date, version_number, notes } = body;
  if (!getSubpoena(subpoenaId)) return c.json({ error: "Subpoena not found" }, 404);
  const r = createProduction({ subpoena_id: subpoenaId, received_date, version_number, notes });
  await insertAuditLog({
    staff_id: me,
    action: "create_production",
    details: `Production ${r.id} on subpoena ${subpoenaId}`,
  });
  return c.json({ success: true, id: r.id });
});

discovery.get("/productions/:id", (c) => {
  const id = Number(c.req.param("id"));
  const p = getProduction(id);
  if (!p) return c.json({ error: "Production not found" }, 404);
  return c.json({ success: true, production: { ...p, items: getProductionItems(id) } });
});

// Delete a single production (and its items/jobs). staff_id via query.
discovery.delete("/productions/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("user").username;
  if (!getProduction(id)) return c.json({ error: "Production not found" }, 404);
  const result = deleteProduction(id);
  await insertAuditLog({
    staff_id: me,
    action: "delete_production",
    details: `Deleted production ${id}`,
  });
  return c.json({ success: true, changes: result.changes });
});

/**
 * Record intake characterization computed from the pdfUtils extraction.
 * The caller passes totals from extractTextFromPdf; this derives chars/page +
 * the image-only flag (threshold mirrors pdfUtils SPARSE_TEXT_THRESHOLD heuristics).
 */
discovery.post("/productions/:id/intake", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const { total_pages, total_chars, timeline_record_id, redaction_status } = body;
  if (!getProduction(id)) return c.json({ error: "Production not found" }, 404);

  const pages = Number(total_pages) || 0;
  const chars = Number(total_chars) || 0;
  const charsPerPage = pages > 0 ? chars / pages : 0;
  const isImageOnly = pages > 0 && charsPerPage < 50; // < ~50 chars/page ⇒ scanned/image
  updateProductionIntake(id, {
    page_count: pages || null,
    text_chars_per_page: pages > 0 ? Number(charsPerPage.toFixed(1)) : null,
    is_image_only: isImageOnly,
    ocr_status: isImageOnly ? "pending" : "not_needed",
    redaction_status: redaction_status ?? null,
    timeline_record_id: timeline_record_id ?? null,
  });
  return c.json({
    success: true,
    is_image_only: isImageOnly,
    text_chars_per_page: Number(charsPerPage.toFixed(1)),
    ocr_status: isImageOnly ? "pending" : "not_needed",
  });
});

/**
 * Reconcile a production against its subpoena's requested items.
 * Body: { staff_id, sections?: [...], text?: string, timeline_record_id?: number }
 * Sections/text may be passed directly (from the live timeline result) or loaded
 * from a saved timeline_records row via timeline_record_id.
 */
discovery.post("/productions/:id/reconcile", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.get("user").username;
  const body = await c.req.json();

  const production = getProduction(id);
  if (!production) return c.json({ error: "Production not found" }, 404);
  const subpoena = getSubpoena(production.subpoena_id);
  if (!subpoena) return c.json({ error: "Subpoena not found" }, 404);

  // Gather produced sections + text sample.
  let sections: any[] = Array.isArray(body.sections) ? body.sections : [];
  let textSample: string = typeof body.text === "string" ? body.text : "";

  const recordId = body.timeline_record_id ?? production.timeline_record_id;
  if (sections.length === 0 && recordId) {
    const rec = await getRecordById(Number(recordId));
    if (rec) {
      try {
        const tl = JSON.parse(rec.timeline);
        sections = Array.isArray(tl.sections) ? tl.sections : [];
        const recSummary = (rec as any).summary;
        if (!textSample && recSummary) textSample = recSummary;
      } catch {
        /* ignore parse errors */
      }
    }
  }

  if (sections.length === 0 && !textSample) {
    return c.json(
      {
        error:
          "No produced content to reconcile. Provide sections/text or link a timeline_record_id.",
      },
      400,
    );
  }

  try {
    const { status, result } = await reconcileProductionContent({
      productionId: id,
      staffId: me,
      sections,
      text: textSample,
    });
    return c.json({ success: true, status, result });
  } catch (err) {
    return c.json({ error: "Reconciliation failed: " + (err as Error).message }, 502);
  }
});

/**
 * Upload a production file and process it in the background:
 *   extract (Vision OCR if scanned) → section → auto-reconcile.
 * Returns a job id immediately; poll GET /productions/:id/job for progress.
 */
discovery.post("/productions/:id/process", async (c) => {
  const id = Number(c.req.param("id"));
  const contentType = c.req.header("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "multipart/form-data file upload required" }, 400);
  }
  const me = c.get("user").username;
  const form = await c.req.formData();
  const production = getProduction(id);
  if (!production) return c.json({ error: "Production not found" }, 404);

  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "A 'file' is required" }, 400);
  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return c.json({ error: "Only PDF productions are supported" }, 400);
  }
  const buffer = Buffer.from(await file.arrayBuffer());

  const { jobId } = startProductionProcessing({
    productionId: id,
    staffId: me,
    buffer,
    filename: file.name,
  });
  await insertAuditLog({
    staff_id: me,
    action: "process_production",
    details: `Production ${id}: queued processing of ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`,
  });
  return c.json({ success: true, jobId, status: "queued" });
});

/** Poll the latest processing job for a production. */
discovery.get("/productions/:id/job", (c) => {
  const id = Number(c.req.param("id"));
  const job = getLatestProductionJob(id);
  if (!job) return c.json({ success: true, job: null });
  return c.json({ success: true, job });
});

// ── Discovery dashboard ─────────────────────────────────────────────────────

discovery.get("/dashboard", (c) => {
  const today = c.req.query("today") || new Date().toISOString().slice(0, 10);
  const overdue = getOverdueSubpoenas(today);
  const cases = listCases();
  const byPhase: Record<string, number> = {};
  for (const cs of cases) byPhase[cs.phase] = (byPhase[cs.phase] || 0) + 1;
  return c.json({
    success: true,
    today,
    totalCases: cases.length,
    byPhase,
    overdueSubpoenas: overdue.map((s) => ({
      id: s.id,
      docket_number: s.docket_number,
      type: s.subpoena_type,
      deadline: s.extended_deadline || s.response_deadline,
      status: s.status,
    })),
  });
});

export default discovery;
