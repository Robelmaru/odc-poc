import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import Anthropic from "@anthropic-ai/sdk";
import { type DocumentTimelineResult } from "../skills/DocumentTimeline.js";
import { extractTextFromPdf, chunkByPages, chunkText } from "../utils/pdfUtils.js";
import {
  CONCURRENCY,
  runWithConcurrency,
  extractChunk,
  mergePartialTimelines,
  finalCleanup,
} from "../utils/timelinePipeline.js";
import { findDuplicateBlocks, type FilePages } from "../utils/duplicateDetector.js";
import { logger } from "../utils/logger.js";

const timeline = new Hono();

// ── SSE streaming route ───────────────────────────────────────────────────

timeline.post("/", async (c) => {
  const contentType = c.req.header("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "File upload required." }, 400);
  }

  const formData = await c.req.formData();
  const files = formData.getAll("files") as File[];
  const additionalContext = formData.get("additionalContext") as string | null;
  const ruleContext = formData.get("ruleContext") === "true"; // analyze with DC Rules / Rule XI context

  if (files.length === 0) {
    return c.json({ error: "No files uploaded." }, 400);
  }

  return streamSSE(c, async (stream) => {
    let eventId = 0;
    const send = async (type: string, data: any) => {
      await stream.writeSSE({ id: String(eventId++), event: type, data: JSON.stringify(data) });
    };

    try {
      await send("progress", {
        step: "start",
        message: "Processing " + files.length + " document(s)...",
      });

      const allPartials: DocumentTimelineResult[] = [];
      const ocrResults: { filename: string; quality: string; score: number }[] = [];
      const sourceTexts: { filename: string; text: string }[] = [];
      const filePages: FilePages[] = []; // per-page text for duplicate-block detection

      for (const file of files) {
        await send("progress", {
          step: "extract_text",
          message: "Extracting text from " + file.name + "...",
        });
        logger.info("  Processing: " + file.name + " (" + (file.size / 1024).toFixed(1) + " KB)");

        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        let chunks: { label: string; text: string }[] = [];

        if (file.name.endsWith(".pdf")) {
          const extraction = await extractTextFromPdf(buffer, async (msg) => {
            await send("progress", { step: "vision_ocr", message: msg });
          });
          sourceTexts.push({
            filename: file.name,
            text: extraction.pages
              .map((p) => p.text)
              .join("\n")
              .slice(0, 50000),
          });
          filePages.push({
            filename: file.name,
            pages: extraction.pages.map((p) => ({ pageNum: p.pageNum, text: p.text })),
          });

          const totalPages = extraction.totalPages;
          const visionInfo =
            extraction.visionPages > 0
              ? ", " +
                extraction.visionPages +
                " via Vision OCR" +
                (extraction.visionClarity != null
                  ? " (" + extraction.visionClarity + "% clarity)"
                  : "")
              : "";
          logger.info(
            "    Extracted " +
              totalPages +
              " pages, " +
              extraction.totalChars.toLocaleString() +
              " chars" +
              visionInfo,
          );
          ocrResults.push({
            filename: file.name,
            quality: extraction.ocrQuality,
            score: extraction.ocrScore,
            visionPages: extraction.visionPages,
            visionClarity: extraction.visionClarity,
          } as any);
          await send("progress", {
            step: "text_extracted",
            message:
              "Extracted " +
              totalPages +
              " pages (" +
              extraction.totalChars.toLocaleString() +
              " chars, OCR: " +
              extraction.ocrQuality +
              visionInfo +
              ")",
          });

          // Dynamic chunk sizing: bigger chunks for bigger docs
          const pagesPerChunk = totalPages > 500 ? 100 : 60;
          const pageChunks = chunkByPages(extraction.pages, pagesPerChunk);
          logger.info(
            "    Split into " + pageChunks.length + " chunk(s) (" + pagesPerChunk + " pages/chunk)",
          );
          await send("progress", {
            step: "chunked",
            message:
              "Split into " + pageChunks.length + " chunk(s) (" + pagesPerChunk + " pages each)",
            totalChunks: pageChunks.length,
          });
          chunks = pageChunks.map((ch) => ({ label: ch.label, text: ch.text }));
        } else if (file.name.endsWith(".txt")) {
          const text = await file.text();
          sourceTexts.push({ filename: file.name, text: text.slice(0, 50000) });
          filePages.push({ filename: file.name, pages: [{ pageNum: null, text }] });
          const textChunks = chunkText(text);
          chunks = textChunks.map((t, i) =>
            textChunks.length > 1
              ? { label: "(Part " + (i + 1) + " of " + textChunks.length + ")", text: t }
              : { label: "", text: t },
          );
          await send("progress", {
            step: "chunked",
            message: "Split into " + chunks.length + " chunk(s)",
            totalChunks: chunks.length,
          });
        } else {
          continue;
        }

        // Parallel chunk extraction
        let completedChunks = 0;
        const totalChunks = chunks.length;

        const extractionTasks = chunks.map((chunk) => () => {
          logger.info(
            "    Extracting timeline " +
              chunk.label +
              (ruleContext ? " [Rule XI context]" : "") +
              "...",
          );
          return extractChunk(
            file.name,
            chunk.text,
            chunk.label,
            additionalContext,
            0,
            ruleContext,
          );
        });

        const docPartials = await runWithConcurrency(
          extractionTasks,
          CONCURRENCY,
          async (_idx, _result) => {
            completedChunks++;
            await send("progress", {
              step: "chunk_done",
              message: "Extracted chunk " + completedChunks + " of " + totalChunks,
              completedChunks,
              totalChunks,
            });
          },
        );

        // Merge chunks for this document
        if (docPartials.length > 1) {
          await send("progress", {
            step: "merging",
            message: "Merging " + docPartials.length + " chunk timelines...",
          });
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
        await send("progress", {
          step: "final_merge",
          message: "Merging " + allPartials.length + " document timelines...",
        });
        finalTimeline = await mergePartialTimelines(allPartials, async (msg) => {
          await send("progress", { step: "final_merge", message: msg });
        });
      } else {
        finalTimeline = allPartials[0]!;
      }

      // Final cleanup
      await send("progress", { step: "cleanup", message: "Final cleanup and deduplication..." });
      const cleanedTimeline = await finalCleanup(finalTimeline);

      // Duplicate content-block detection (deterministic, over extracted page text)
      await send("progress", {
        step: "duplicates",
        message: "Scanning for duplicate content blocks...",
      });
      const duplicates = findDuplicateBlocks(filePages);
      logger.info(
        "Done. " +
          (cleanedTimeline.timeline?.length ?? 0) +
          " events extracted, " +
          duplicates.matches.length +
          " duplicate match(es).",
      );

      await send("complete", {
        timeline: cleanedTimeline,
        ocrResults: ocrResults.length > 0 ? ocrResults : undefined,
        sourceTexts: sourceTexts.length > 0 ? sourceTexts : undefined,
        duplicates,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
    } catch (error) {
      logger.error("Timeline extraction error", {
        error: error instanceof Error ? error.message : String(error),
      });
      const message =
        error instanceof Anthropic.APIError
          ? "Claude API error: " + error.message
          : error instanceof Error
            ? error.message
            : "Timeline extraction failed";
      await send("error", { message });
    }
  });
});

// ── Rule XI comparison (non-streaming) ──────────────────────────────────────
// Extracts text ONCE, then sections the document twice — without and with the
// DC Rules / Rule XI interpretive context — so staff can see, side by side, how
// the disciplinary lens changes the analysis. Single file; keep it modestly sized.

async function sectionDocument(
  filename: string,
  pages: { pageNum: number; text: string }[],
  totalPages: number,
  ruleContext: boolean,
): Promise<DocumentTimelineResult> {
  const pagesPerChunk = totalPages > 500 ? 100 : 60;
  const pageChunks = chunkByPages(pages as any, pagesPerChunk);
  const partials = await runWithConcurrency(
    pageChunks.map((ch) => () => extractChunk(filename, ch.text, ch.label, null, 0, ruleContext)),
    CONCURRENCY,
  );
  const merged = partials.length > 1 ? await mergePartialTimelines(partials) : partials[0]!;
  return finalCleanup(merged);
}

timeline.post("/compare", async (c) => {
  const contentType = c.req.header("Content-Type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "File upload required." }, 400);
  }
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file || typeof file === "string" || typeof (file as any).name !== "string") {
    return c.json({ error: "A single 'file' is required." }, 400);
  }

  // Comparison runs TWO analysis passes, so bound it to a sample of pages — a
  // side-by-side is illustrative and shouldn't fully process (and OCR) a huge
  // document twice. Tunable via COMPARE_MAX_PAGES.
  const COMPARE_MAX_PAGES = Math.max(5, Number(process.env.COMPARE_MAX_PAGES) || 40);

  try {
    let pages: { pageNum: number; text: string }[] = [];
    let totalPages = 0;
    let visionPages = 0;
    if (file.name.toLowerCase().endsWith(".pdf")) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const extraction = await extractTextFromPdf(buffer, undefined, COMPARE_MAX_PAGES);
      pages = extraction.pages.map((p) => ({ pageNum: p.pageNum, text: p.text }));
      totalPages = extraction.totalPages;
      visionPages = extraction.visionPages;
    } else if (file.name.toLowerCase().endsWith(".txt")) {
      const text = await file.text();
      pages = [{ pageNum: 1, text }];
      totalPages = 1;
    } else {
      return c.json({ error: "Only PDF or TXT files are supported." }, 400);
    }

    const sampledPages = pages.length;

    // Section twice off the same extracted text (OCR cost paid once).
    const [without, withRule] = await Promise.all([
      sectionDocument(file.name, pages, sampledPages, false),
      sectionDocument(file.name, pages, sampledPages, true),
    ]);

    return c.json({
      success: true,
      filename: file.name,
      totalPages,
      sampledPages,
      truncated: sampledPages < totalPages,
      visionPages,
      without,
      withRuleXI: withRule,
    });
  } catch (error) {
    const message =
      error instanceof Anthropic.APIError
        ? "Claude API error: " + error.message
        : error instanceof Error
          ? error.message
          : "Comparison failed";
    return c.json({ error: message }, 502);
  }
});

export default timeline;
