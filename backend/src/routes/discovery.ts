import type { FastifyInstance } from "fastify";
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
  listProductionsForSubpoenas,
  getItemsForProductions,
  groupBy,
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
import { authUser } from "../auth/session.js";
import { safeJsonParse } from "../utils/json.js";
import { readMultipart } from "../utils/multipart.js";

const tags = { tags: ["discovery"] };
const paramId = (request: { params: unknown }) => Number((request.params as { id: string }).id);

export default async function discovery(app: FastifyInstance) {
  // ── Checklist (UI seed) ─────────────────────────────────────────────────────
  app.get("/checklist", { schema: tags }, async () => ({
    success: true,
    checklist: SUBPOENA_CHECKLIST,
  }));

  // ── Respondent attorneys ────────────────────────────────────────────────────
  app.post("/respondents", { schema: tags }, async (request, reply) => {
    const me = authUser(request).username;
    const { name, bar_number, firm, email, phone } = (request.body ?? {}) as Record<string, string>;
    if (!name) return reply.code(400).send({ error: "name is required" });
    const r = await createRespondent({ name, bar_number, firm, email, phone });
    await insertAuditLog({
      staff_id: me,
      action: "create_respondent",
      details: `${name} (ID ${r.id})`,
    });
    return { success: true, id: r.id };
  });

  app.get("/respondents", { schema: tags }, async () => ({
    success: true,
    respondents: await listRespondents(),
  }));

  // ── Cases ────────────────────────────────────────────────────────────────────
  app.post("/cases", { schema: tags }, async (request) => {
    const me = authUser(request).username;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const r = await createCase({
      year: Number(body.year) || new Date().getFullYear(),
      respondent_id: (body.respondent_id as number) ?? null,
      complainant_name: (body.complainant_name as string) ?? null,
      client_name: (body.client_name as string) ?? null,
      matter_caption: (body.matter_caption as string) ?? null,
      analysis_record_id: (body.analysis_record_id as number) ?? null,
      created_by: me,
    });
    await insertAuditLog({
      staff_id: me,
      action: "create_case",
      details: `${r.docket_number} (ID ${r.id})`,
    });
    return { success: true, id: r.id, docket_number: r.docket_number };
  });

  app.get("/cases", { schema: tags }, async () => ({ success: true, cases: await listCases() }));

  app.get("/cases/:id", { schema: tags }, async (request, reply) => {
    const id = paramId(request);
    const caseRow = await getCase(id);
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });
    // Batched (4 queries total, not 1 + N + N×M — DB-005).
    const subpoenaRows = await listSubpoenasByCase(id);
    const prodRows = await listProductionsForSubpoenas(subpoenaRows.map((s) => s.id));
    const itemsByProd = groupBy(
      await getItemsForProductions(prodRows.map((p) => p.id)),
      (i) => i.production_id,
    );
    const prodsBySub = groupBy(
      prodRows.map((p) => ({ ...p, items: itemsByProd.get(p.id) ?? [] })),
      (p) => p.subpoena_id,
    );
    const subpoenas = subpoenaRows.map((s) => ({
      ...s,
      requested_items: safeJsonParse(s.requested_items, []),
      productions: prodsBySub.get(s.id) ?? [],
    }));
    return { success: true, case: caseRow, subpoenas };
  });

  app.post("/cases/:id/phase", { schema: tags }, async (request, reply) => {
    const id = paramId(request);
    const me = authUser(request).username;
    const { phase } = (request.body ?? {}) as { phase?: string };
    if (!(await getCase(id))) return reply.code(404).send({ error: "Case not found" });
    if (!(await updateCasePhase(id, phase as string)))
      return reply.code(400).send({ error: "Invalid phase" });
    await insertAuditLog({ staff_id: me, action: "case_phase", details: `Case ${id} -> ${phase}` });
    return { success: true };
  });

  app.post("/cases/:id/status", { schema: tags }, async (request, reply) => {
    const id = paramId(request);
    const me = authUser(request).username;
    const { status } = (request.body ?? {}) as { status?: string };
    if (!(await getCase(id))) return reply.code(404).send({ error: "Case not found" });
    if (!(await updateCaseStatus(id, status as string)))
      return reply.code(400).send({ error: "Invalid status" });
    await insertAuditLog({
      staff_id: me,
      action: "case_status",
      details: `Case ${id} -> ${status}`,
    });
    return { success: true };
  });

  app.delete("/cases/:id", { schema: tags }, async (request, reply) => {
    const id = paramId(request);
    const me = authUser(request).username;
    const caseRow = await getCase(id);
    if (!caseRow) return reply.code(404).send({ error: "Case not found" });
    const result = await deleteCase(id);
    await insertAuditLog({
      staff_id: me,
      action: "delete_case",
      details: `Deleted ${caseRow.docket_number} (ID ${id}) and all subpoenas/productions`,
    });
    return { success: true, changes: result.changes };
  });

  // ── Subpoenas ─────────────────────────────────────────────────────────────
  app.post("/cases/:id/subpoenas", { schema: tags }, async (request, reply) => {
    const caseId = paramId(request);
    const me = authUser(request).username;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!(await getCase(caseId))) return reply.code(404).send({ error: "Case not found" });

    const subpoena_type = (body.subpoena_type as string) || "BOTH";
    let requested_items: { item_type: string; description: string }[];
    if (Array.isArray(body.requested_items) && body.requested_items.length > 0) {
      requested_items = body.requested_items as { item_type: string; description: string }[];
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

    const r = await createSubpoena({
      case_id: caseId,
      subpoena_type,
      issuance_date: (body.issuance_date as string) ?? null,
      response_deadline: (body.response_deadline as string) ?? null,
      requested_items,
      created_by: me,
    });
    await insertAuditLog({
      staff_id: me,
      action: "create_subpoena",
      details: `Subpoena ${r.id} (${subpoena_type}) on case ${caseId}, due ${body.response_deadline ?? "n/a"}`,
    });
    return { success: true, id: r.id, requested_items };
  });

  app.get("/subpoenas/:id", { schema: tags }, async (request, reply) => {
    const id = paramId(request);
    const s = await getSubpoena(id);
    if (!s) return reply.code(404).send({ error: "Subpoena not found" });
    const prodRows = await listProductionsForSubpoenas([id]);
    const itemsByProd = groupBy(
      await getItemsForProductions(prodRows.map((p) => p.id)),
      (i) => i.production_id,
    );
    return {
      success: true,
      subpoena: { ...s, requested_items: safeJsonParse(s.requested_items, []) },
      productions: prodRows.map((p) => ({ ...p, items: itemsByProd.get(p.id) ?? [] })),
    };
  });

  app.post("/subpoenas/:id/status", { schema: tags }, async (request, reply) => {
    const id = paramId(request);
    const me = authUser(request).username;
    const { status } = (request.body ?? {}) as { status?: string };
    if (!(await getSubpoena(id))) return reply.code(404).send({ error: "Subpoena not found" });
    if (!(await updateSubpoenaStatus(id, status as string)))
      return reply.code(400).send({ error: "Invalid status" });
    await insertAuditLog({
      staff_id: me,
      action: "subpoena_status",
      details: `Subpoena ${id} -> ${status}`,
    });
    return { success: true };
  });

  app.post("/subpoenas/:id/extend", { schema: tags }, async (request, reply) => {
    const id = paramId(request);
    const me = authUser(request).username;
    const { extended_deadline, reason } = (request.body ?? {}) as {
      extended_deadline?: string;
      reason?: string;
    };
    if (!(await getSubpoena(id))) return reply.code(404).send({ error: "Subpoena not found" });
    if (!extended_deadline) return reply.code(400).send({ error: "extended_deadline is required" });
    await extendSubpoenaDeadline(id, extended_deadline);
    await insertAuditLog({
      staff_id: me,
      action: "subpoena_extend",
      details: `Subpoena ${id} extended to ${extended_deadline}${reason ? " — " + reason : ""}`,
    });
    return { success: true };
  });

  // ── Productions ─────────────────────────────────────────────────────────────
  app.post("/subpoenas/:id/productions", { schema: tags }, async (request, reply) => {
    const subpoenaId = paramId(request);
    const me = authUser(request).username;
    const { received_date, version_number, notes } = (request.body ?? {}) as Record<
      string,
      unknown
    >;
    if (!(await getSubpoena(subpoenaId)))
      return reply.code(404).send({ error: "Subpoena not found" });
    const r = await createProduction({
      subpoena_id: subpoenaId,
      received_date: received_date as string,
      version_number: version_number as number,
      notes: notes as string,
    });
    await insertAuditLog({
      staff_id: me,
      action: "create_production",
      details: `Production ${r.id} on subpoena ${subpoenaId}`,
    });
    return { success: true, id: r.id };
  });

  app.get("/productions/:id", { schema: tags }, async (request, reply) => {
    const id = paramId(request);
    const p = await getProduction(id);
    if (!p) return reply.code(404).send({ error: "Production not found" });
    return { success: true, production: { ...p, items: await getProductionItems(id) } };
  });

  app.delete("/productions/:id", { schema: tags }, async (request, reply) => {
    const id = paramId(request);
    const me = authUser(request).username;
    if (!(await getProduction(id))) return reply.code(404).send({ error: "Production not found" });
    const result = await deleteProduction(id);
    await insertAuditLog({
      staff_id: me,
      action: "delete_production",
      details: `Deleted production ${id}`,
    });
    return { success: true, changes: result.changes };
  });

  app.post("/productions/:id/intake", { schema: tags }, async (request, reply) => {
    const id = paramId(request);
    const { total_pages, total_chars, timeline_record_id, redaction_status } = (request.body ??
      {}) as Record<string, unknown>;
    if (!(await getProduction(id))) return reply.code(404).send({ error: "Production not found" });
    const pages = Number(total_pages) || 0;
    const chars = Number(total_chars) || 0;
    const charsPerPage = pages > 0 ? chars / pages : 0;
    const isImageOnly = pages > 0 && charsPerPage < 50;
    await updateProductionIntake(id, {
      page_count: pages || null,
      text_chars_per_page: pages > 0 ? Number(charsPerPage.toFixed(1)) : null,
      is_image_only: isImageOnly,
      ocr_status: isImageOnly ? "pending" : "not_needed",
      redaction_status: (redaction_status as string) ?? null,
      timeline_record_id: (timeline_record_id as number) ?? null,
    });
    return {
      success: true,
      is_image_only: isImageOnly,
      text_chars_per_page: Number(charsPerPage.toFixed(1)),
      ocr_status: isImageOnly ? "pending" : "not_needed",
    };
  });

  app.post("/productions/:id/reconcile", { schema: tags }, async (request, reply) => {
    const id = paramId(request);
    const me = authUser(request).username;
    const body = (request.body ?? {}) as Record<string, unknown>;

    const production = await getProduction(id);
    if (!production) return reply.code(404).send({ error: "Production not found" });
    const subpoena = await getSubpoena(production.subpoena_id);
    if (!subpoena) return reply.code(404).send({ error: "Subpoena not found" });

    let sections: unknown[] = Array.isArray(body.sections) ? (body.sections as unknown[]) : [];
    let textSample: string = typeof body.text === "string" ? (body.text as string) : "";

    const recordId = (body.timeline_record_id as number) ?? production.timeline_record_id;
    if (sections.length === 0 && recordId) {
      const rec = await getRecordById(Number(recordId));
      if (rec) {
        try {
          const tl = JSON.parse(rec.timeline);
          sections = Array.isArray(tl.sections) ? tl.sections : [];
          const recSummary = (rec as { summary?: string }).summary;
          if (!textSample && recSummary) textSample = recSummary;
        } catch {
          /* ignore parse errors */
        }
      }
    }

    if (sections.length === 0 && !textSample) {
      return reply.code(400).send({
        error:
          "No produced content to reconcile. Provide sections/text or link a timeline_record_id.",
      });
    }

    try {
      const { status, result } = await reconcileProductionContent({
        productionId: id,
        staffId: me,
        sections,
        text: textSample,
      });
      return { success: true, status, result };
    } catch (err) {
      return reply.code(502).send({ error: "Reconciliation failed: " + (err as Error).message });
    }
  });

  app.post("/productions/:id/process", { schema: tags }, async (request, reply) => {
    const id = paramId(request);
    if (!request.isMultipart())
      return reply.code(400).send({ error: "multipart/form-data file upload required" });
    const me = authUser(request).username;
    const { files } = await readMultipart(request);
    const production = await getProduction(id);
    if (!production) return reply.code(404).send({ error: "Production not found" });

    const file = files.find((f) => f.field === "file") ?? files[0];
    if (!file) return reply.code(400).send({ error: "A 'file' is required" });
    if (!file.filename.toLowerCase().endsWith(".pdf"))
      return reply.code(400).send({ error: "Only PDF productions are supported" });

    const { jobId } = await startProductionProcessing({
      productionId: id,
      staffId: me,
      buffer: file.buffer,
      filename: file.filename,
    });
    await insertAuditLog({
      staff_id: me,
      action: "process_production",
      details: `Production ${id}: queued processing of ${file.filename} (${(file.size / 1024 / 1024).toFixed(1)} MB)`,
    });
    return { success: true, jobId, status: "queued" };
  });

  app.get("/productions/:id/job", { schema: tags }, async (request) => {
    const job = await getLatestProductionJob(paramId(request));
    return { success: true, job: job ?? null };
  });

  // ── Discovery dashboard ─────────────────────────────────────────────────────
  app.get("/dashboard", { schema: tags }, async (request) => {
    const today =
      (request.query as { today?: string }).today || new Date().toISOString().slice(0, 10);
    const overdue = await getOverdueSubpoenas(today);
    const cases = await listCases();
    const byPhase: Record<string, number> = {};
    for (const cs of cases) byPhase[cs.phase] = (byPhase[cs.phase] || 0) + 1;
    return {
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
    };
  });
}
