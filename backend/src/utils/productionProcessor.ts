// Background processing for a subpoena production:
//   upload → extract text (Vision OCR for scanned pages) → section → reconcile.
//
// Reconciliation reuses the SAME sectioning the timeline feature produces
// (via utils/timelinePipeline), so the compliance check sees exactly what the
// timeline view shows. Job state transitions are recorded in production_jobs so
// the frontend can poll a long-running 1,000+ page production.

import Anthropic from "@anthropic-ai/sdk";
import { extractTextFromPdf, chunkByPages } from "./pdfUtils.js";
import { extractSectionsOnly } from "./timelinePipeline.js";
import { type DocumentTimelineResult } from "../skills/DocumentTimeline.js";
import {
  productionCompliancePrompt,
  type ProductionComplianceResult,
} from "../skills/ProductionCompliance.js";
import { insertRecord, insertNotification, insertAuditLog } from "../db/database.js";
import {
  getProduction,
  getSubpoena,
  getCase,
  updateProductionIntake,
  updateProductionStatus,
  updateSubpoenaStatus,
  replaceProductionItems,
  rollupProductionStatus,
  setProductionReconcileMeta,
  linkTimelineRecordToCase,
  createProductionJob,
  updateProductionJob,
} from "../db/discovery.js";

const anthropic = new Anthropic();

function parseJson<T>(raw: string): T {
  let text = raw.trim();
  if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*\n?/, "");
  if (text.endsWith("```")) text = text.replace(/\n?```\s*$/, "");
  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error("Could not extract JSON from model response: " + text.slice(0, 120));
  }
}

/**
 * Reconcile produced content (sections + text sample) against a production's
 * subpoena requested_items. Persists production_items, rolls up the production
 * status, reflects onto the subpoena, and notifies/audits. Shared by the
 * interactive /reconcile route and the background processor so both behave
 * identically.
 */
export async function reconcileProductionContent(opts: {
  productionId: number;
  staffId: string;
  sections: any[];
  text: string;
}): Promise<{ status: string; result: ProductionComplianceResult }> {
  const production = getProduction(opts.productionId);
  if (!production) throw new Error("Production not found");
  const subpoena = getSubpoena(production.subpoena_id);
  if (!subpoena) throw new Error("Subpoena not found");

  const requestedItems = JSON.parse(subpoena.requested_items) as {
    item_type: string;
    description: string;
  }[];

  const userContent =
    "REQUESTED ITEMS (the subpoena's demand):\n" +
    JSON.stringify(requestedItems, null, 2) +
    "\n\nSUBPOENA TYPE: " +
    subpoena.subpoena_type +
    "\n\nPRODUCED SECTIONS (section index of the production):\n" +
    JSON.stringify((opts.sections || []).slice(0, 400), null, 2) +
    "\n\nPRODUCED TEXT (SAMPLE, may be truncated):\n" +
    (opts.text || "").slice(0, 60000) +
    "\n\nReconcile each requested item. Remember: demand/request language is NOT a produced artifact. Return only JSON.";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    system: productionCompliancePrompt,
    messages: [{ role: "user", content: userContent }],
  });
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("No response from model");
  const result = parseJson<ProductionComplianceResult>(block.text);

  const items = Array.isArray(result.items) ? result.items : [];
  replaceProductionItems(
    opts.productionId,
    items.map((i) => ({
      item_type: i.item_type,
      status: i.status,
      source_section_id: i.source_section_id ?? null,
      confidence: i.confidence ?? null,
      notes: i.notes ?? null,
    })),
  );
  const rollup = rollupProductionStatus(items);
  updateProductionStatus(opts.productionId, rollup);
  setProductionReconcileMeta(opts.productionId, {
    rule115_flags: Array.isArray(result.rule115Flags) ? result.rule115Flags : [],
    follow_up: result.recommendedFollowUp || "",
  });

  if (rollup === "complete") {
    updateSubpoenaStatus(subpoena.id, "fully_received");
  } else if (items.length > 0) {
    updateSubpoenaStatus(subpoena.id, "partially_received");
  }

  const missing = items.filter((i) => i.status === "missing" || i.status === "defective");
  if (missing.length > 0) {
    await insertNotification({
      staff_id: opts.staffId,
      message: `Production ${opts.productionId}: ${missing.length} item(s) missing/defective — ${missing
        .map((m) => m.label || m.item_type)
        .slice(0, 4)
        .join(", ")}`,
      link: `production:${opts.productionId}`,
    });
  }
  await insertAuditLog({
    staff_id: opts.staffId,
    action: "reconcile_production",
    details: `Production ${opts.productionId}: ${rollup} (${missing.length} missing/defective of ${items.length})`,
  });

  return { status: rollup, result };
}

/**
 * Full background pipeline for an uploaded production file.
 * Returns the job id immediately to the caller; the work runs to completion as a
 * floating promise. Poll production_jobs (GET /productions/:id/job) for progress.
 */
export function startProductionProcessing(opts: {
  productionId: number;
  staffId: string;
  buffer: Buffer;
  filename: string;
}): { jobId: number } {
  const job = createProductionJob(opts.productionId);
  // Fire-and-forget; the Node event loop keeps it alive while the server runs.
  void runPipeline(job.id, opts).catch((err) => {
    updateProductionJob(job.id, {
      status: "failed",
      error: (err as Error).message?.slice(0, 500) || "Unknown error",
      message: "Processing failed",
    });
  });
  return { jobId: job.id };
}

async function runPipeline(
  jobId: number,
  opts: { productionId: number; staffId: string; buffer: Buffer; filename: string },
): Promise<void> {
  const { productionId, staffId, buffer, filename } = opts;
  const production = getProduction(productionId);
  if (!production) throw new Error("Production not found");
  const subpoena = getSubpoena(production.subpoena_id);
  if (!subpoena) throw new Error("Subpoena not found");
  const caseRow = getCase(subpoena.case_id);

  // 1) Extract text (Vision OCR for scanned pages happens inside extractTextFromPdf).
  updateProductionJob(jobId, { status: "extracting", message: "Extracting text…" });
  const extraction = await extractTextFromPdf(buffer, async (msg) => {
    updateProductionJob(jobId, { message: msg });
  });

  const totalPages = extraction.totalPages || extraction.pages.length || 0;
  const charsPerPage = totalPages > 0 ? extraction.totalChars / totalPages : 0;
  // is_image_only reflects how the document actually arrived: a majority of pages
  // had no usable text layer and required OCR (local Tesseract and/or Vision).
  const imageOnly = totalPages > 0 && extraction.ocrPages / totalPages > 0.5;
  updateProductionIntake(productionId, {
    page_count: totalPages,
    text_chars_per_page: Number(charsPerPage.toFixed(1)),
    is_image_only: imageOnly,
    ocr_status: extraction.ocrPages > 0 ? "done" : "not_needed",
  });

  // 2) Build the sub-document INDEX only (section-index-only pass — no timeline
  //    extraction or merge tree). Reconciliation only needs the section index, so
  //    this is far faster/cheaper than the full DocumentTimeline pipeline.
  updateProductionJob(jobId, {
    status: "sectioning",
    message: `Indexing ${totalPages} page(s) into sub-documents…`,
  });
  const pagesPerChunk = totalPages > 500 ? 100 : 60;
  const pageChunks = chunkByPages(extraction.pages, pagesPerChunk);
  const timelineResult: DocumentTimelineResult = await extractSectionsOnly(
    filename,
    pageChunks.map((ch) => ({ label: ch.label, text: ch.text })),
    {
      onChunkDone: (done, total) =>
        updateProductionJob(jobId, { message: `Indexing sub-documents… chunk ${done}/${total}` }),
    },
  );

  const sourceText = extraction.pages
    .map((p) => p.text)
    .join("\n")
    .slice(0, 60000);

  // 3) Persist as a timeline record and link it to the production + case.
  const rec = await insertRecord({
    staff_id: staffId,
    record_name: filename,
    case_number: caseRow?.docket_number ?? null,
    file_names: JSON.stringify([filename]),
    notes: `Production ${productionId} (subpoena ${subpoena.id})`,
    summary: (timelineResult as any).summary ?? null,
    timeline: JSON.stringify(timelineResult),
  });
  const recordId = Number(rec.lastInsertRowid);
  updateProductionIntake(productionId, { timeline_record_id: recordId });
  if (caseRow) linkTimelineRecordToCase(recordId, caseRow.id, productionId);

  // 4) Reconcile against the subpoena's requested items.
  updateProductionJob(jobId, {
    status: "reconciling",
    message: "Reconciling produced documents against the subpoena…",
  });
  const { status, result } = await reconcileProductionContent({
    productionId,
    staffId,
    sections: (timelineResult as any).sections || [],
    text: sourceText,
  });

  const missing = (result.items || []).filter(
    (i) => i.status === "missing" || i.status === "defective",
  ).length;
  updateProductionJob(jobId, {
    status: "done",
    message: `Done — status "${status}", ${missing} item(s) missing/defective of ${
      (result.items || []).length
    }.`,
  });
  await insertNotification({
    staff_id: staffId,
    message: `Production ${productionId} processed (${
      imageOnly ? "OCR'd, " : ""
    }${totalPages} pages): ${status}${missing ? `, ${missing} missing/defective` : ""}`,
    link: `production:${productionId}`,
  });
}
