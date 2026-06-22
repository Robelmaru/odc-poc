import type { FastifyInstance } from "fastify";
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
import { readMultipart } from "../utils/multipart.js";

async function sectionDocument(
  filename: string,
  pages: { pageNum: number; text: string }[],
  totalPages: number,
  ruleContext: boolean,
): Promise<DocumentTimelineResult> {
  const pagesPerChunk = totalPages > 500 ? 100 : 60;
  const pageChunks = chunkByPages(pages as never, pagesPerChunk);
  const partials = await runWithConcurrency(
    pageChunks.map((ch) => () => extractChunk(filename, ch.text, ch.label, null, 0, ruleContext)),
    CONCURRENCY,
  );
  const merged = partials.length > 1 ? await mergePartialTimelines(partials) : partials[0]!;
  return finalCleanup(merged);
}

export default async function timeline(app: FastifyInstance) {
  // ── SSE streaming extraction ──────────────────────────────────────────────
  app.post("/", { schema: { tags: ["timeline"] } }, async (request, reply) => {
    if (!request.isMultipart()) return reply.code(400).send({ error: "File upload required." });

    // Open the SSE response and flush headers + a keepalive BEFORE buffering the
    // (potentially very large) upload. A big production can take well over a minute
    // just to transfer; if we wait until the whole body is read to send the first
    // byte, an upstream proxy / load balancer times out the connection and the
    // browser sees "Failed to fetch" / ERR_CONNECTION_TIMED_OUT. Flushing early
    // (paired with `proxy-request-buffering: off` on the ingress) makes the LB see a
    // response immediately and keeps the connection alive while the file uploads.
    // X-Accel-Buffering disables nginx response buffering for the SSE stream.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    let eventId = 0;
    const send = (type: string, data: unknown) => {
      res.write(`id: ${eventId++}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Heartbeat during the upload/buffering window so idle-timeout proxies don't
    // drop the connection while a large file is still being received (no SSE data
    // flows until readMultipart resolves).
    const heartbeat = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        /* ignore */
      }
    }, 15000);

    try {
      send("progress", { step: "upload", message: "Receiving upload..." });
      const { files, fields } = await readMultipart(request);
      clearInterval(heartbeat);
      const additionalContext = fields.additionalContext ?? null;
      const ruleContext = fields.ruleContext === "true";
      if (files.length === 0) {
        send("error", { message: "No files uploaded." });
        res.end();
        return;
      }

      send("progress", {
        step: "start",
        message: "Processing " + files.length + " document(s)...",
      });

      const allPartials: DocumentTimelineResult[] = [];
      const ocrResults: {
        filename: string;
        quality: string;
        score: number;
        visionPages?: number;
        visionClarity?: number;
      }[] = [];
      const sourceTexts: { filename: string; text: string }[] = [];
      const filePages: FilePages[] = [];

      for (const file of files) {
        send("progress", {
          step: "extract_text",
          message: "Extracting text from " + file.filename + "...",
        });
        logger.info(
          "  Processing: " + file.filename + " (" + (file.size / 1024).toFixed(1) + " KB)",
        );

        let chunks: { label: string; text: string }[] = [];

        if (file.filename.endsWith(".pdf")) {
          const extraction = await extractTextFromPdf(file.buffer, async (msg) => {
            send("progress", { step: "vision_ocr", message: msg });
          });
          sourceTexts.push({
            filename: file.filename,
            text: extraction.pages
              .map((p) => p.text)
              .join("\n")
              .slice(0, 50000),
          });
          filePages.push({
            filename: file.filename,
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
          ocrResults.push({
            filename: file.filename,
            quality: extraction.ocrQuality,
            score: extraction.ocrScore,
            visionPages: extraction.visionPages,
            visionClarity: extraction.visionClarity,
          });
          send("progress", {
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

          const pagesPerChunk = totalPages > 500 ? 100 : 60;
          const pageChunks = chunkByPages(extraction.pages, pagesPerChunk);
          send("progress", {
            step: "chunked",
            message:
              "Split into " + pageChunks.length + " chunk(s) (" + pagesPerChunk + " pages each)",
            totalChunks: pageChunks.length,
          });
          chunks = pageChunks.map((ch) => ({ label: ch.label, text: ch.text }));
        } else if (file.filename.endsWith(".txt")) {
          const text = file.buffer.toString("utf8");
          sourceTexts.push({ filename: file.filename, text: text.slice(0, 50000) });
          filePages.push({ filename: file.filename, pages: [{ pageNum: null, text }] });
          const textChunks = chunkText(text);
          chunks = textChunks.map((t, i) =>
            textChunks.length > 1
              ? { label: "(Part " + (i + 1) + " of " + textChunks.length + ")", text: t }
              : { label: "", text: t },
          );
          send("progress", {
            step: "chunked",
            message: "Split into " + chunks.length + " chunk(s)",
            totalChunks: chunks.length,
          });
        } else {
          continue;
        }

        let completedChunks = 0;
        const totalChunks = chunks.length;
        const extractionTasks = chunks.map(
          (chunk) => () =>
            extractChunk(file.filename, chunk.text, chunk.label, additionalContext, 0, ruleContext),
        );
        const docPartials = await runWithConcurrency(extractionTasks, CONCURRENCY, async () => {
          completedChunks++;
          send("progress", {
            step: "chunk_done",
            message: "Extracted chunk " + completedChunks + " of " + totalChunks,
            completedChunks,
            totalChunks,
          });
        });

        if (docPartials.length > 1) {
          send("progress", {
            step: "merging",
            message: "Merging " + docPartials.length + " chunk timelines...",
          });
          allPartials.push(
            await mergePartialTimelines(docPartials, async (msg) => {
              send("progress", { step: "merging", message: msg });
            }),
          );
        } else {
          allPartials.push(docPartials[0]!);
        }
      }

      if (allPartials.length === 0) {
        send("error", { message: "No supported files could be processed." });
        res.end();
        return;
      }

      let finalTimeline: DocumentTimelineResult;
      if (allPartials.length > 1) {
        send("progress", {
          step: "final_merge",
          message: "Merging " + allPartials.length + " document timelines...",
        });
        finalTimeline = await mergePartialTimelines(allPartials, async (msg) => {
          send("progress", { step: "final_merge", message: msg });
        });
      } else {
        finalTimeline = allPartials[0]!;
      }

      send("progress", { step: "cleanup", message: "Final cleanup and deduplication..." });
      const cleanedTimeline = await finalCleanup(finalTimeline);

      send("progress", { step: "duplicates", message: "Scanning for duplicate content blocks..." });
      const duplicates = findDuplicateBlocks(filePages);
      logger.info(
        "Done. " +
          (cleanedTimeline.timeline?.length ?? 0) +
          " events extracted, " +
          duplicates.matches.length +
          " duplicate match(es).",
      );

      send("complete", {
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
      send("error", { message });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  // ── Rule XI comparison (non-streaming) ──────────────────────────────────────
  app.post("/compare", { schema: { tags: ["timeline"] } }, async (request, reply) => {
    if (!request.isMultipart()) return reply.code(400).send({ error: "File upload required." });
    const { files } = await readMultipart(request);
    const file = files[0];
    if (!file) return reply.code(400).send({ error: "A single 'file' is required." });

    const COMPARE_MAX_PAGES = Math.max(5, Number(process.env.COMPARE_MAX_PAGES) || 40);

    try {
      let pages: { pageNum: number; text: string }[] = [];
      let totalPages = 0;
      let visionPages = 0;
      if (file.filename.toLowerCase().endsWith(".pdf")) {
        const extraction = await extractTextFromPdf(file.buffer, undefined, COMPARE_MAX_PAGES);
        pages = extraction.pages.map((p) => ({ pageNum: p.pageNum, text: p.text }));
        totalPages = extraction.totalPages;
        visionPages = extraction.visionPages;
      } else if (file.filename.toLowerCase().endsWith(".txt")) {
        pages = [{ pageNum: 1, text: file.buffer.toString("utf8") }];
        totalPages = 1;
      } else {
        return reply.code(400).send({ error: "Only PDF or TXT files are supported." });
      }

      const sampledPages = pages.length;
      const [without, withRule] = await Promise.all([
        sectionDocument(file.filename, pages, sampledPages, false),
        sectionDocument(file.filename, pages, sampledPages, true),
      ]);

      return {
        success: true,
        filename: file.filename,
        totalPages,
        sampledPages,
        truncated: sampledPages < totalPages,
        visionPages,
        without,
        withRuleXI: withRule,
      };
    } catch (error) {
      const message =
        error instanceof Anthropic.APIError
          ? "Claude API error: " + error.message
          : error instanceof Error
            ? error.message
            : "Comparison failed";
      return reply.code(502).send({ error: message });
    }
  });
}
