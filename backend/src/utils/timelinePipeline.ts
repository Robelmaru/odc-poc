// Shared timeline-extraction pipeline helpers.
//
// These were originally defined inline in routes/timeline.ts. They are factored
// here verbatim so both the timeline route (interactive, SSE) and the production
// processor (background job) extract and section documents IDENTICALLY — the
// production-reconciliation step depends on the same `sections[]` the timeline
// feature produces, so the two must never diverge.

import Anthropic from "@anthropic-ai/sdk";
import { documentTimelinePrompt, type DocumentTimelineResult } from "../skills/DocumentTimeline.js";
import { timelineMergePrompt } from "../skills/TimelineMerge.js";
import { sectionIndexPrompt } from "../skills/SectionIndex.js";
import { dcRulesKnowledge } from "../knowledge/dcRules.js";
import { logger } from "./logger.js";
import { logTokenUsage } from "./usage.js";

// System prompt for the sectioning/timeline pass. When `ruleContext` is true, the
// DC Rules of Professional Conduct + Rule XI reference is prepended so the model
// classifies sub-documents and weighs significance through the disciplinary lens.
function timelineSystemPrompt(ruleContext: boolean): string {
  return ruleContext
    ? "You are assisting the DC Office of Disciplinary Counsel. Use the following DC Rules of Professional Conduct and Rule XI (Disciplinary Proceedings) as interpretive context when identifying sub-documents and judging the significance of events — give higher significance to material bearing on potential rule violations (e.g. trust/IOLTA handling under Rule 1.15, diligence under Rule 1.3, communication under Rule 1.4).\n\n" +
        dcRulesKnowledge +
        "\n\n" +
        documentTimelinePrompt
    : documentTimelinePrompt;
}

const anthropic = new Anthropic();

/** Parallel API calls (configurable; bounded to stay clear of rate limits). */
export const CONCURRENCY = Math.min(12, Math.max(1, Number(process.env.SECTION_CONCURRENCY) || 5));

const EMPTY_TIMELINE: DocumentTimelineResult = {
  documents: [],
  sections: [],
  timeline: [],
  timelineSpan: { earliest: "", latest: "", totalDuration: "" },
  conflicts: [],
  keyDates: [],
  notes: [],
};

export function parseTimelineJson(raw: string): DocumentTimelineResult {
  let text = raw.trim();
  if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*\n?/, "");
  if (text.endsWith("```")) text = text.replace(/\n?```\s*$/, "");
  try {
    return JSON.parse(text.trim());
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error("Could not extract JSON from Claude response: " + text.slice(0, 100));
  }
}

/** Run async tasks with limited concurrency. */
export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  onComplete?: (index: number, result: T) => void,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const idx = next++;
      const result = await tasks[idx]!();
      results[idx] = result;
      if (onComplete) onComplete(idx, result);
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function extractChunk(
  filename: string,
  chunkText: string,
  chunkLabel: string,
  additionalContext: string | null,
  retryCount = 0,
  ruleContext = false,
): Promise<DocumentTimelineResult> {
  const MAX_RETRIES = 2;

  const parts: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text: "--- Document: " + filename + " " + chunkLabel + " ---\n\n" + chunkText + "\n\n",
    },
  ];

  if (additionalContext?.trim()) {
    parts.push({
      type: "text",
      text: "--- Additional Context ---\n\n" + additionalContext + "\n\n",
    });
  }

  const instruction =
    retryCount > 0
      ? "IMPORTANT: Output ONLY valid JSON, no prose or explanation. Extract a chronological timeline from this text. Be VERY CONCISE — only HIGH significance events. Filename: " +
        filename
      : "Extract all dates, events, and people from this text and return as structured JSON. Be CONCISE — focus on the most significant events. When citing sources, use the EXACT filename: " +
        filename;

  parts.push({ type: "text", text: instruction });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16384,
    system: timelineSystemPrompt(ruleContext),
    messages: [{ role: "user", content: parts }],
  });
  logTokenUsage("timeline-extract-chunk", response.usage);

  if (response.stop_reason === "max_tokens") {
    logger.debug(
      "    Warning: response truncated for " +
        filename +
        " " +
        chunkLabel +
        ", retrying concise...",
    );
    if (retryCount < MAX_RETRIES) {
      return extractChunk(
        filename,
        chunkText,
        chunkLabel,
        additionalContext,
        retryCount + 1,
        ruleContext,
      );
    }
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No response from Claude");

  try {
    return parseTimelineJson(textBlock.text);
  } catch (err) {
    logger.debug("    Parse failed for " + chunkLabel + ": " + (err as Error).message.slice(0, 80));
    if (retryCount < MAX_RETRIES) {
      logger.debug("    Retrying chunk " + chunkLabel + " (attempt " + (retryCount + 2) + ")...");
      return extractChunk(
        filename,
        chunkText,
        chunkLabel,
        additionalContext,
        retryCount + 1,
        ruleContext,
      );
    }
    logger.debug("    Skipping chunk " + chunkLabel + " after " + MAX_RETRIES + " retries");
    return { ...EMPTY_TIMELINE };
  }
}

export async function mergeTwoTimelines(
  a: DocumentTimelineResult,
  b: DocumentTimelineResult,
): Promise<DocumentTimelineResult> {
  const payload = JSON.stringify([a, b]);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16384,
    system: timelineMergePrompt,
    messages: [
      {
        role: "user",
        content:
          "Merge these 2 partial timelines into one. Deduplicate events and keep the most significant. Return valid JSON only.\n\n" +
          payload,
      },
    ],
  });
  logTokenUsage("timeline-merge", response.usage);

  if (response.stop_reason === "max_tokens") {
    logger.debug("    Warning: merge truncated, retrying concise...");
    const retry = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      system: timelineMergePrompt,
      messages: [
        {
          role: "user",
          content:
            "Merge these 2 partial timelines. Be VERY CONCISE — deduplicate and keep only HIGH and MEDIUM significance events. Return valid JSON only.\n\n" +
            payload,
        },
      ],
    });
    logTokenUsage("timeline-merge-retry", retry.usage);
    const retryBlock = retry.content.find((b) => b.type === "text");
    if (!retryBlock || retryBlock.type !== "text") throw new Error("Merge retry failed");
    return parseTimelineJson(retryBlock.text);
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("Merge failed");
  return parseTimelineJson(textBlock.text);
}

export async function mergePartialTimelines(
  partials: DocumentTimelineResult[],
  onProgress?: (msg: string) => void,
): Promise<DocumentTimelineResult> {
  if (partials.length === 1) return partials[0]!;

  let current = partials;
  let round = 1;
  while (current.length > 1) {
    const pairs = Math.ceil(current.length / 2);
    if (onProgress)
      onProgress(
        "Merge round " +
          round +
          ": combining " +
          current.length +
          " timelines into " +
          pairs +
          "...",
      );

    const mergeTasks: (() => Promise<DocumentTimelineResult>)[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        const a = current[i]!,
          b = current[i + 1]!;
        mergeTasks.push(() => mergeTwoTimelines(a, b));
      } else {
        const carry = current[i]!;
        mergeTasks.push(() => Promise.resolve(carry));
      }
    }

    current = await runWithConcurrency(mergeTasks, CONCURRENCY);
    round++;
  }
  return current[0]!;
}

export async function finalCleanup(tl: DocumentTimelineResult): Promise<DocumentTimelineResult> {
  try {
    const timelineCount = tl.timeline?.length ?? 0;
    const sectionsCount = tl.sections?.length ?? 0;
    if (timelineCount <= 20 && sectionsCount <= 10) return tl;

    const payload = JSON.stringify(tl);
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      system:
        "You are a legal document analyst. Clean up this merged timeline: remove exact duplicates, ensure strict chronological order, verify date formats are YYYY-MM-DD, and write a concise overall summary. Also clean up the 'sections' array (the Table of Contents of sub-documents inside each PDF): sort by filename and startPage ascending, merge adjacent fragments of the same logical sub-document (same filename, same sectionType, abutting page ranges, matching title/parties), and remove exact duplicate entries. Do NOT merge genuinely distinct sub-documents that happen to be adjacent. Output only valid JSON in the same DocumentTimelineResult format (including the 'sections' field). No markdown code fences.",
      messages: [
        {
          role: "user",
          content:
            "Clean up and finalize this timeline. Remove duplicates, sort chronologically, and add a brief overall summary.\n\n" +
            payload,
        },
      ],
    });
    logTokenUsage("timeline-cleanup", response.usage);

    if (response.stop_reason === "max_tokens") {
      logger.debug("    Cleanup truncated, using unclean timeline.");
      return tl;
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return tl;
    return parseTimelineJson(textBlock.text);
  } catch (err) {
    logger.debug("    Cleanup pass failed, using unclean timeline", {
      error: err instanceof Error ? err.message : String(err),
    });
    return tl;
  }
}

// ── Section-index-only extraction ───────────────────────────────────────────
// Lightweight pass that extracts ONLY the sub-document index (no timeline/events,
// no merge tree). Sections from different page ranges simply concatenate, so this
// avoids the expensive pairwise-merge + cleanup passes entirely. Returns a
// DocumentTimelineResult-shaped object with only `sections` populated.

type Section = { startPage?: number; [k: string]: unknown };

async function extractSectionsChunk(
  filename: string,
  chunkText: string,
  chunkLabel: string,
  ruleContext: boolean,
  retryCount = 0,
): Promise<Section[]> {
  const MAX_RETRIES = 1;
  const system = ruleContext ? dcRulesKnowledge + "\n\n" + sectionIndexPrompt : sectionIndexPrompt;
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    system,
    messages: [
      {
        role: "user",
        content:
          "--- Document: " +
          filename +
          " " +
          chunkLabel +
          " ---\n\n" +
          chunkText +
          "\n\nIndex the sub-documents in this text. Use the EXACT filename: " +
          filename +
          ". Return only JSON.",
      },
    ],
  });
  logTokenUsage("timeline-sections", response.usage);
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return [];
  try {
    const parsed = parseTimelineJson(block.text) as unknown as { sections?: Section[] };
    return Array.isArray(parsed.sections) ? parsed.sections : [];
  } catch {
    if (retryCount < MAX_RETRIES) {
      return extractSectionsChunk(filename, chunkText, chunkLabel, ruleContext, retryCount + 1);
    }
    logger.debug("    Section-index parse failed for " + chunkLabel + ", skipping chunk.");
    return [];
  }
}

export async function extractSectionsOnly(
  filename: string,
  chunks: { label: string; text: string }[],
  opts: { ruleContext?: boolean; onChunkDone?: (done: number, total: number) => void } = {},
): Promise<DocumentTimelineResult> {
  let done = 0;
  const total = chunks.length;
  const perChunk = await runWithConcurrency(
    chunks.map(
      (ch) => () => extractSectionsChunk(filename, ch.text, ch.label, opts.ruleContext ?? false),
    ),
    CONCURRENCY,
    () => {
      done++;
      opts.onChunkDone?.(done, total);
    },
  );

  const sections = perChunk.flat();
  // Concatenate across chunks and sort by page (sections come from disjoint ranges).
  sections.sort((a, b) => (a?.startPage ?? 0) - (b?.startPage ?? 0));

  return {
    ...EMPTY_TIMELINE,
    sections: sections as unknown as DocumentTimelineResult["sections"],
  };
}
