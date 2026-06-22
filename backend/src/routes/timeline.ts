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
import { readMultipart, type UploadedFile } from "../utils/multipart.js";
import { appendChunk, readUpload, cleanupUpload, sweepOldUploads } from "../utils/uploadStore.js";

type SendFn = (type: string, data: unknown) => void;

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

// Core extraction pipeline. Emits SSE progress events via `send` and finishes
// with a "complete" event; throws on failure (the caller emits the "error"
// event and ends the stream). Shared by the single-shot "/" route and the
// chunked-upload "/process" route.
async function runTimelineExtraction(
  files: UploadedFile[],
  additionalContext: string | null,
  ruleContext: boolean,
  send: SendFn,
): Promise<void> {
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
    logger.info("  Processing: " + file.filename + " (" + (file.size / 1024).toFixed(1) + " KB)");

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
            (extraction.visionClarity != null ? " (" + extraction.visionClarity + "% clarity)" : "")
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
        message: "Split into " + pageChunks.length + " chunk(s) (" + pagesPerChunk + " pages each)",
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
    throw new Error("No supported files could be processed.");
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
}

// Open an SSE response on a hijacked reply. Returns the writer plus an end()
// that tears down the heartbeat and closes the socket.
function openSse(reply: import("fastify").FastifyReply): {
  send: SendFn;
  end: () => void;
} {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Tell nginx not to buffer the event stream so events (and the heartbeat)
    // reach the client immediately.
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  let eventId = 0;
  const send: SendFn = (type, data) => {
    res.write(`id: ${eventId++}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Heartbeat: large documents have long silent processing steps (whole-file
  // pdf-parse, multi-pass Claude merges) with no events. A proxied HTTP/2 stream
  // that goes idle gets reset by the load balancer (ERR_HTTP2_PROTOCOL_ERROR), so
  // emit a comment line every 10s to keep it alive. Comments (": …") are ignored
  // by the SSE client.
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* socket gone */
    }
  }, 10000);
  const end = () => {
    clearInterval(heartbeat);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };
  return { send, end };
}

function errorMessage(error: unknown): string {
  return error instanceof Anthropic.APIError
    ? "Claude API error: " + error.message
    : error instanceof Error
      ? error.message
      : "Timeline extraction failed";
}

export default async function timeline(app: FastifyInstance) {
  // ── Single-shot multipart upload + SSE extraction (small files) ─────────────
  // Large files can't use this path — the whole upload must arrive in one request
  // and the LB times out the slow transfer. The frontend uses /upload + /process.
  app.post("/", { schema: { tags: ["timeline"] } }, async (request, reply) => {
    if (!request.isMultipart()) return reply.code(400).send({ error: "File upload required." });
    const { files, fields } = await readMultipart(request);
    const additionalContext = fields.additionalContext ?? null;
    const ruleContext = fields.ruleContext === "true";
    if (files.length === 0) return reply.code(400).send({ error: "No files uploaded." });

    const { send, end } = openSse(reply);
    try {
      await runTimelineExtraction(files, additionalContext, ruleContext, send);
    } catch (error) {
      logger.error("Timeline extraction error", {
        error: error instanceof Error ? error.message : String(error),
      });
      send("error", { message: errorMessage(error) });
    } finally {
      end();
    }
  });

  // ── Chunked upload: append one chunk of a file to its temp file on disk ──────
  // Each call is a short request (well under any LB timeout); the client sends
  // chunks in order. Returns the bytes received so far.
  app.post("/upload", { schema: { tags: ["timeline"] } }, async (request, reply) => {
    if (!request.isMultipart())
      return reply.code(400).send({ error: "multipart/form-data required." });
    const { files, fields } = await readMultipart(request);
    const uploadId = fields.uploadId;
    const filename = fields.filename;
    const index = Number(fields.index ?? "0");
    const chunk = files[0];
    if (!uploadId || !filename)
      return reply.code(400).send({ error: "uploadId and filename are required." });
    if (!chunk) return reply.code(400).send({ error: "A 'chunk' file part is required." });
    try {
      const size = await appendChunk(uploadId, filename, chunk.buffer, Number.isFinite(index) ? index : 0);
      return { ok: true, size };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Upload failed." });
    }
  });

  // ── Process previously-uploaded (assembled) files and stream results (SSE) ───
  // Body is tiny (just ids), so this request starts immediately and streams
  // progress — no large upload to time out.
  app.post(
    "/process",
    {
      schema: {
        tags: ["timeline"],
        body: {
          type: "object",
          required: ["uploads"],
          properties: {
            uploads: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: {
                type: "object",
                required: ["uploadId", "filename"],
                properties: {
                  uploadId: { type: "string", maxLength: 128 },
                  filename: { type: "string", maxLength: 256 },
                },
              },
            },
            additionalContext: { type: "string" },
            ruleContext: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        uploads: { uploadId: string; filename: string }[];
        additionalContext?: string;
        ruleContext?: boolean;
      };

      const { send, end } = openSse(reply);
      try {
        void sweepOldUploads();
        const files: UploadedFile[] = [];
        for (const u of body.uploads) {
          const buffer = await readUpload(u.uploadId, u.filename);
          files.push({ field: "files", filename: u.filename, buffer, size: buffer.length });
        }
        await runTimelineExtraction(
          files,
          body.additionalContext ?? null,
          body.ruleContext === true,
          send,
        );
      } catch (error) {
        logger.error("Timeline extraction error", {
          error: error instanceof Error ? error.message : String(error),
        });
        send("error", { message: errorMessage(error) });
      } finally {
        for (const u of body.uploads) await cleanupUpload(u.uploadId);
        end();
      }
    },
  );

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
