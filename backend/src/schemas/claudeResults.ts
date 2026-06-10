import { z } from "zod";

/**
 * Runtime validation for Claude JSON output (finding TS-001). The model can
 * return a structurally wrong object; without validation those values flow into
 * DB writes (production_items, rule115_flags) and API responses. Per-field
 * `.catch(...)` coerces bad/missing leaf values to safe defaults so a single bad
 * field can't corrupt a row, while a non-object response still fails loudly.
 */

// ── ProductionCompliance (written to the discovery DB) ──────────────────────

const ComplianceItemSchema = z
  .object({
    item_type: z.string().catch(""),
    label: z.string().catch(""),
    status: z.enum(["received", "partial", "missing", "defective"]).catch("missing"),
    confidence: z.enum(["HIGH", "MEDIUM", "LOW"]).catch("LOW"),
    source_section_id: z.string().nullable().catch(null),
    evidence: z.string().catch(""),
    notes: z.string().catch(""),
  })
  .passthrough();

export const ProductionComplianceResultSchema = z
  .object({
    items: z.array(ComplianceItemSchema).catch([]),
    summary: z.string().catch(""),
    missingCount: z.number().catch(0),
    rule115Flags: z.array(z.string()).catch([]),
    recommendedFollowUp: z.string().catch(""),
  })
  .passthrough();

// ── AnalyzeComplaint (returned to the client / saved as a record) ───────────
// Lenient: guarantee the arrays the UI iterates exist; pass the rest through.

export const AnalysisResultSchema = z
  .object({
    summary: z.string().catch(""),
    timeline: z.array(z.unknown()).catch([]),
    factualAllegations: z.array(z.unknown()).catch([]),
    potentialViolations: z.array(z.unknown()).catch([]),
    aggravatingFactors: z.array(z.unknown()).catch([]),
    mitigatingFactors: z.array(z.unknown()).catch([]),
    informationGaps: z.array(z.unknown()).catch([]),
    conflictsAndInconsistencies: z.array(z.unknown()).catch([]),
    nextSteps: z.array(z.unknown()).catch([]),
  })
  .passthrough();
