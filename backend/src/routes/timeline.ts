import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import Anthropic from "@anthropic-ai/sdk";
import { documentTimelinePrompt, type DocumentTimelineResult } from "../skills/DocumentTimeline.js";
import { timelineMergePrompt } from "../skills/TimelineMerge.js";
import { extractTextFromPdf, chunkByPages, chunkText } from "../utils/pdfUtils.js";

const timeline = new Hono();
const anthropic = new Anthropic();

const CONCURRENCY = 3; // parallel API calls

// ── helpers ────────────────────────────────────────────────────────────────

function parseTimelineJson(raw: string): DocumentTimelineResult {
  let text = raw.trim();
  // Strip code fences
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "");
  }
  if (text.endsWith("```")) {
    text = text.replace(/\n?```\s*$/, "");
  }
  // Try direct parse first
  try {
    return JSON.parse(text.trim());
  } catch {
    // Claude may have wrapped JSON in prose — try to extract it
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error("Could not extract JSON from Claude response: " + text.slice(0, 100));
  }
}

/** Run async tasks with limited concurrency */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
  onComplete?: (index: number, result: T) => void
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

async function extractChunk(
  filename: string,
  chunkText: string,
  chunkLabel: string,
  additionalContext: string | null,
  retryCount = 0
): Promise<DocumentTimelineResult> {
  const MAX_RETRIES = 2;

  const parts: Anthropic.ContentBlockParam[] = [
    { type: "text", text: "--- Document: " + filename + " " + chunkLabel + " ---\n\n" + chunkText + "\n\n" },
  ];

  if (additionalContext?.trim()) {
    parts.push({ type: "text", text: "--- Additional Context ---\n\n" + additionalContext + "\n\n" });
  }

  // On retry, use a stricter prompt
  const instruction = retryCount > 0
    ? "IMPORTANT: Output ONLY valid JSON, no prose or explanation. Extract a chronological timeline from this text. Be VERY CONCISE — only HIGH significance events. Filename: " + filename
    : "Extract all dates, events, and people from this text and return as structured JSON. Be CONCISE — focus on the most significant events. When citing sources, use the EXACT filename: " + filename;

  parts.push({ type: "text", text: instruction });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16384,
    system: documentTimelinePrompt,
    messages: [{ role: "user", content: parts }],
  });

  if (response.stop_reason === "max_tokens") {
    console.log("    Warning: response truncated for " + filename + " " + chunkLabel + ", retrying concise...");
    if (retryCount < MAX_RETRIES) {
      return extractChunk(filename, chunkText, chunkLabel, additionalContext, retryCount + 1);
    }
    // Last resort: try to parse what we have
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No response from Claude");

  try {
    return parseTimelineJson(textBlock.text);
  } catch (err) {
    console.log("    Parse failed for " + chunkLabel + ": " + (err as Error).message.slice(0, 80));
    if (retryCount < MAX_RETRIES) {
      console.log("    Retrying chunk " + chunkLabel + " (attempt " + (retryCount + 2) + ")...");
      return extractChunk(filename, chunkText, chunkLabel, additionalContext, retryCount + 1);
    }
    // Return empty timeline for this chunk rather than crashing the whole job
    console.log("    Skipping chunk " + chunkLabel + " after " + MAX_RETRIES + " retries");
    return { documents: [], sections: [], timeline: [], timelineSpan: { earliest: "", latest: "", totalDuration: "" }, conflicts: [], keyDates: [], notes: [] };
  }
}

async function mergeTwoTimelines(
  a: DocumentTimelineResult,
  b: DocumentTimelineResult
): Promise<DocumentTimelineResult> {
  const payload = JSON.stringify([a, b]);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16384,
    system: timelineMergePrompt,
    messages: [
      {
        role: "user",
        content: "Merge these 2 partial timelines into one. Deduplicate events and keep the most significant. Return valid JSON only.\n\n" + payload,
      },
    ],
  });

  if (response.stop_reason === "max_tokens") {
    console.log("    Warning: merge truncated, retrying concise...");
    const retry = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      system: timelineMergePrompt,
      messages: [
        {
          role: "user",
          content: "Merge these 2 partial timelines. Be VERY CONCISE — deduplicate and keep only HIGH and MEDIUM significance events. Return valid JSON only.\n\n" + payload,
        },
      ],
    });
    const retryBlock = retry.content.find((b) => b.type === "text");
    if (!retryBlock || retryBlock.type !== "text") throw new Error("Merge retry failed");
    return parseTimelineJson(retryBlock.text);
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("Merge failed");
  return parseTimelineJson(textBlock.text);
}

async function mergePartialTimelines(
  partials: DocumentTimelineResult[],
  onProgress?: (msg: string) => void
): Promise<DocumentTimelineResult> {
  if (partials.length === 1) return partials[0]!;

  let current = partials;
  let round = 1;
  while (current.length > 1) {
    const pairs = Math.ceil(current.length / 2);
    if (onProgress) onProgress("Merge round " + round + ": combining " + current.length + " timelines into " + pairs + "...");

    // Merge pairs in parallel (with concurrency limit)
    const mergeTasks: (() => Promise<DocumentTimelineResult>)[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        const a = current[i]!, b = current[i + 1]!;
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

async function finalCleanup(tl: DocumentTimelineResult): Promise<DocumentTimelineResult> {
  try {
    const timelineCount = tl.timeline?.length ?? 0;
    const sectionsCount = tl.sections?.length ?? 0;
    if (timelineCount <= 20 && sectionsCount <= 10) return tl;

    const payload = JSON.stringify(tl);
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      system: "You are a legal document analyst. Clean up this merged timeline: remove exact duplicates, ensure strict chronological order, verify date formats are YYYY-MM-DD, and write a concise overall summary. Also clean up the 'sections' array (the Table of Contents of sub-documents inside each PDF): sort by filename and startPage ascending, merge adjacent fragments of the same logical sub-document (same filename, same sectionType, abutting page ranges, matching title/parties), and remove exact duplicate entries. Do NOT merge genuinely distinct sub-documents that happen to be adjacent. Output only valid JSON in the same DocumentTimelineResult format (including the 'sections' field). No markdown code fences.",
      messages: [
        {
          role: "user",
          content: "Clean up and finalize this timeline. Remove duplicates, sort chronologically, and add a brief overall summary.\n\n" + payload,
        },
      ],
    });

    if (response.stop_reason === "max_tokens") {
      console.log("    Cleanup truncated, using unclean timeline.");
      return tl;
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return tl;
    return parseTimelineJson(textBlock.text);
  } catch (err) {
    console.log("    Cleanup pass failed, using unclean timeline:", err);
    return tl;
  }
}

// ── SSE streaming route ───────────────────────────────────────────────────

timeline.post("/", async (c) => {
  const contentType = c.req.header("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "File upload required." }, 400);
  }

  const formData = await c.req.formData();
  const files = formData.getAll("files") as File[];
  const additionalContext = formData.get("additionalContext") as string | null;

  if (files.length === 0) {
    return c.json({ error: "No files uploaded." }, 400);
  }

  return streamSSE(c, async (stream) => {
    let eventId = 0;
    const send = async (type: string, data: any) => {
      await stream.writeSSE({ id: String(eventId++), event: type, data: JSON.stringify(data) });
    };

    try {
      await send("progress", { step: "start", message: "Processing " + files.length + " document(s)..." });

      const allPartials: DocumentTimelineResult[] = [];
      const ocrResults: { filename: string; quality: string; score: number }[] = [];
      const sourceTexts: { filename: string; text: string }[] = [];

      for (const file of files) {
        await send("progress", { step: "extract_text", message: "Extracting text from " + file.name + "..." });
        console.log("  Processing: " + file.name + " (" + (file.size / 1024).toFixed(1) + " KB)");

        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        let chunks: { label: string; text: string }[] = [];

        if (file.name.endsWith(".pdf")) {
          const extraction = await extractTextFromPdf(buffer, async (msg) => {
            await send("progress", { step: "vision_ocr", message: msg });
          });
          sourceTexts.push({
            filename: file.name,
            text: extraction.pages.map((p) => p.text).join("\n").slice(0, 50000),
          });

          const totalPages = extraction.totalPages;
          const visionInfo = extraction.visionPages > 0
            ? ", " + extraction.visionPages + " via Vision OCR"
              + (extraction.visionClarity != null ? " (" + extraction.visionClarity + "% clarity)" : "")
            : "";
          console.log("    Extracted " + totalPages + " pages, " + extraction.totalChars.toLocaleString() + " chars" + visionInfo);
          ocrResults.push({
            filename: file.name,
            quality: extraction.ocrQuality,
            score: extraction.ocrScore,
            visionPages: extraction.visionPages,
            visionClarity: extraction.visionClarity,
          } as any);
          await send("progress", {
            step: "text_extracted",
            message: "Extracted " + totalPages + " pages (" + extraction.totalChars.toLocaleString() + " chars, OCR: " + extraction.ocrQuality + visionInfo + ")",
          });

          // Dynamic chunk sizing: bigger chunks for bigger docs
          const pagesPerChunk = totalPages > 500 ? 100 : 60;
          const pageChunks = chunkByPages(extraction.pages, pagesPerChunk);
          console.log("    Split into " + pageChunks.length + " chunk(s) (" + pagesPerChunk + " pages/chunk)");
          await send("progress", {
            step: "chunked",
            message: "Split into " + pageChunks.length + " chunk(s) (" + pagesPerChunk + " pages each)",
            totalChunks: pageChunks.length,
          });
          chunks = pageChunks.map((ch) => ({ label: ch.label, text: ch.text }));
        } else if (file.name.endsWith(".txt")) {
          const text = await file.text();
          sourceTexts.push({ filename: file.name, text: text.slice(0, 50000) });
          const textChunks = chunkText(text);
          chunks = textChunks.map((t, i) =>
            textChunks.length > 1
              ? { label: "(Part " + (i + 1) + " of " + textChunks.length + ")", text: t }
              : { label: "", text: t }
          );
          await send("progress", { step: "chunked", message: "Split into " + chunks.length + " chunk(s)", totalChunks: chunks.length });
        } else {
          continue;
        }

        // Parallel chunk extraction
        let completedChunks = 0;
        const totalChunks = chunks.length;

        const extractionTasks = chunks.map((chunk) => () => {
          console.log("    Extracting timeline " + chunk.label + "...");
          return extractChunk(file.name, chunk.text, chunk.label, additionalContext);
        });

        const docPartials = await runWithConcurrency(extractionTasks, CONCURRENCY, async (_idx, _result) => {
          completedChunks++;
          await send("progress", {
            step: "chunk_done",
            message: "Extracted chunk " + completedChunks + " of " + totalChunks,
            completedChunks,
            totalChunks,
          });
        });

        // Merge chunks for this document
        if (docPartials.length > 1) {
          await send("progress", { step: "merging", message: "Merging " + docPartials.length + " chunk timelines..." });
          const merged = await mergePartialTimelines(docPartials, async (msg) => {
            await send("progress", { step: "merging", message: msg });
          });
          allPartials.push(merged);
        } else {
          allPartials.push(docPartials[0]!);
        }
      }

      if (allPartials.length === 0) {
        await send("error", { message: "No supported files could be processed." });
        return;
      }

      // Final merge across documents
      let finalTimeline: DocumentTimelineResult;
      if (allPartials.length > 1) {
        await send("progress", { step: "final_merge", message: "Merging " + allPartials.length + " document timelines..." });
        finalTimeline = await mergePartialTimelines(allPartials, async (msg) => {
          await send("progress", { step: "final_merge", message: msg });
        });
      } else {
        finalTimeline = allPartials[0]!;
      }

      // Final cleanup
      await send("progress", { step: "cleanup", message: "Final cleanup and deduplication..." });
      const cleanedTimeline = await finalCleanup(finalTimeline);

      console.log("Done. " + (cleanedTimeline.timeline?.length ?? 0) + " events extracted.");

      await send("complete", {
        timeline: cleanedTimeline,
        ocrResults: ocrResults.length > 0 ? ocrResults : undefined,
        sourceTexts: sourceTexts.length > 0 ? sourceTexts : undefined,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    } catch (error) {
      console.error("Timeline extraction error:", error);
      const message = error instanceof Anthropic.APIError
        ? "Claude API error: " + error.message
        : (error instanceof Error ? error.message : "Timeline extraction failed");
      await send("error", { message });
    }
  });
});

export default timeline;
