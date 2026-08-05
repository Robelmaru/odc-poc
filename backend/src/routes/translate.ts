import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { translatePrompt, detectLanguagePrompt, TARGET_LANGUAGE, buildTextTranslationPrompt, buildTextTranslationRecord } from "../skills/Translate.js";
import { createAnthropicClient } from "../utils/anthropic.js";
import { extractTextFromPdf, chunkText } from "../utils/pdfUtils.js";
import { logger } from "../utils/logger.js";
import { logTokenUsage } from "../utils/usage.js";
import { readMultipart } from "../utils/multipart.js";
import {
  writeChunkAt,
  readUpload,
  uploadSize,
  cleanupUpload,
  sweepOldUploads,
} from "../utils/uploadStore.js";
import { randomUUID } from "node:crypto";


type SendFn = (type: string, data: unknown) => void;

// ── Background jobs (own store; isolated from the timeline route) ─────────────
// Translate/convert of a scanned doc runs minutes of OCR — too long for a single
// synchronous request through the load balancer. The client uploads in chunks,
// then polls this job for progress + result. In-memory is fine (single replica).
interface JobEvent {
  type: string;
  data: unknown;
}
interface Job {
  status: "running" | "complete" | "error";
  events: JobEvent[];
  createdAt: number;
}
const jobs = new Map<string, Job>();

function sweepJobs(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}

async function detectLanguage(text: string): Promise<string> {
  const anthropic = createAnthropicClient();
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 50,
    system: detectLanguagePrompt(),
    messages: [{ role: "user", content: text.slice(0, 4000) }],
  });
  logTokenUsage("translate-detect", response.usage);
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return "Unknown";
  return textBlock.text.trim() || "Unknown";
}

async function translateChunk(text: string): Promise<string> {
  const anthropic = createAnthropicClient();
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    system: translatePrompt(),
    messages: [{ role: "user", content: text }],
  });
  logTokenUsage("translate", response.usage);
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No response from Claude");
  return textBlock.text;
}

async function translateTextChunk(text: string, sourceLanguage: string, targetLanguage: string): Promise<string> {
  const anthropic = createAnthropicClient();
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: buildTextTranslationPrompt(sourceLanguage, targetLanguage),
    messages: [{ role: "user", content: text.slice(0, 12000) }],
  });
  logTokenUsage("translate-text", response.usage);
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No response from Claude");
  return textBlock.text;
}

// Shared pipeline for "translate" (any language → English) and "convert"
// (handwriting/scanned → readable text, no translation). extractTextFromPdf
// already OCRs handwriting via Claude Vision, so "convert" just returns that
// transcription. Emits progress events into the job buffer; throws on failure.
async function runTranslateJob(
  files: { filename: string; buffer: Buffer; size: number }[],
  mode: "translate" | "convert",
  send: SendFn,
): Promise<void> {
  const results: Record<string, unknown>[] = [];
  const ocrInfo: { filename: string; visionPages: number; visionClarity?: number }[] = [];
  const sourceTexts: { filename: string; text: string }[] = [];

  for (const file of files) {
    send("progress", { message: "Reading " + file.filename + "..." });
    let fullText = "";
    let pages: number | undefined;

    if (file.filename.toLowerCase().endsWith(".pdf")) {
      // Convert (handwriting) forces Claude Vision OCR — Tesseract mangles
      // handwriting into dashes. Translate keeps the default (Tesseract-first,
      // Vision fallback), which is fine for printed foreign-language text.
      const extracted = await extractTextFromPdf(
        file.buffer,
        async (msg) => {
          send("progress", { message: msg });
        },
        undefined,
        mode === "convert",
      );
      fullText = extracted.pages.map((p) => p.text).join("\n\n");
      pages = extracted.totalPages;
      if (extracted.visionPages > 0) {
        ocrInfo.push({
          filename: file.filename,
          visionPages: extracted.visionPages,
          visionClarity: extracted.visionClarity,
        });
      }
      sourceTexts.push({ filename: file.filename, text: fullText.slice(0, 50000) });
    } else if (file.filename.toLowerCase().endsWith(".txt")) {
      fullText = file.buffer.toString("utf8");
      sourceTexts.push({ filename: file.filename, text: fullText.slice(0, 50000) });
    } else {
      continue;
    }

    if (mode === "convert") {
      send("progress", { message: "Transcribed " + file.filename });
      results.push({ filename: file.filename, text: fullText, pages });
    } else {
      const detectedLanguage = await detectLanguage(fullText);
      if (detectedLanguage.toLowerCase() === TARGET_LANGUAGE.toLowerCase()) {
        send("progress", { message: file.filename + " is already in " + TARGET_LANGUAGE + "." });
        results.push({ filename: file.filename, translation: fullText, pages, detectedLanguage });
      } else {
        const chunks = chunkText(fullText);
        const out: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          send("progress", {
            message:
              "Translating " +
              file.filename +
              " (from " +
              detectedLanguage +
              ") — part " +
              (i + 1) +
              " of " +
              chunks.length +
              "...",
          });
          out.push(await translateChunk(chunks[i]!));
        }
        results.push({
          filename: file.filename,
          translation: out.join("\n\n"),
          pages,
          detectedLanguage,
        });
      }
    }
  }

  if (results.length === 0) throw new Error("No supported files could be processed.");

  send("complete", {
    mode,
    success: true,
    language: "en",
    languageName: TARGET_LANGUAGE,
    results,
    ocrInfo: ocrInfo.length > 0 ? ocrInfo : undefined,
    sourceTexts: sourceTexts.length > 0 ? sourceTexts : undefined,
    usage: { inputTokens: 0, outputTokens: 0 },
  });
}

export default async function translate(app: FastifyInstance) {
  app.post("/text", { schema: { tags: ["translate"] } }, async (request, reply) => {
    try {
      const body = (request.body ?? {}) as {
        text?: string;
        sourceLanguage?: string;
        targetLanguage?: string;
      };
      const text = body.text?.trim();
      if (!text) return reply.code(400).send({ error: "Text is required." });

      const sourceLanguage = body.sourceLanguage || "Auto-detect";
      const targetLanguage = body.targetLanguage || TARGET_LANGUAGE;
      const detectedLanguage = sourceLanguage === "Auto-detect" ? await detectLanguage(text) : sourceLanguage;

      const translation = await translateTextChunk(text, detectedLanguage, targetLanguage);
      const record = buildTextTranslationRecord(targetLanguage, translation);
      return {
        success: true,
        detectedLanguage,
        sourceLanguage,
        targetLanguage,
        translation,
        record,
      };
    } catch (error) {
      logger.error("Text translation error", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Anthropic.APIError) {
        return reply
          .code((error.status ?? 500) as number)
          .send({ error: `Claude API error: ${error.message}` });
      }
      return reply.code(500).send({ error: "Text translation failed" });
    }
  });

  app.post("/", { schema: { tags: ["translate"] } }, async (request, reply) => {
    try {
      if (!request.isMultipart()) return reply.code(400).send({ error: "File upload required." });
      const { files } = await readMultipart(request);

      if (files.length === 0)
        return reply.code(400).send({ error: "Please upload at least one document." });

      logger.info(`Translating ${files.length} file(s) to ${TARGET_LANGUAGE}...`);

      const results: {
        filename: string;
        translation: string;
        pages?: number;
        detectedLanguage: string;
      }[] = [];
      const ocrInfo: { filename: string; visionPages: number; visionClarity?: number }[] = [];
      const sourceTexts: { filename: string; text: string }[] = [];

      for (const file of files) {
        logger.info(`  Processing: ${file.filename} (${(file.size / 1024).toFixed(1)} KB)`);
        let fullText = "";
        let pages: number | undefined;

        if (file.filename.endsWith(".pdf")) {
          const extracted = await extractTextFromPdf(file.buffer);
          fullText = extracted.pages.map((p) => p.text).join("\n\n");
          pages = extracted.totalPages;
          if (extracted.visionPages > 0) {
            ocrInfo.push({
              filename: file.filename,
              visionPages: extracted.visionPages,
              visionClarity: extracted.visionClarity,
            });
          }
          sourceTexts.push({ filename: file.filename, text: fullText.slice(0, 50000) });
        } else if (file.filename.endsWith(".txt")) {
          fullText = file.buffer.toString("utf8");
          sourceTexts.push({ filename: file.filename, text: fullText.slice(0, 50000) });
        } else {
          logger.info(`    Skipping unsupported file type: ${file.filename}`);
          continue;
        }

        const detectedLanguage = await detectLanguage(fullText);
        logger.info(`    Detected source language: ${detectedLanguage}`);

        let translation: string;
        if (detectedLanguage.toLowerCase() === TARGET_LANGUAGE.toLowerCase()) {
          logger.info(`    Already in ${TARGET_LANGUAGE} — skipping translation.`);
          translation = fullText;
        } else {
          const chunks = chunkText(fullText);
          logger.info(`    Translating in ${chunks.length} chunk(s)...`);
          const translatedChunks: string[] = [];
          for (let i = 0; i < chunks.length; i++) {
            logger.info(`    Chunk ${i + 1}/${chunks.length}...`);
            translatedChunks.push(await translateChunk(chunks[i]!));
          }
          translation = translatedChunks.join("\n\n");
        }

        results.push({
          filename: file.filename,
          translation,
          pages,
          detectedLanguage,
        });
      }

      if (results.length === 0)
        return reply.code(400).send({ error: "No supported files could be processed." });

      logger.info(`Translation complete for ${results.length} file(s).`);
      return {
        success: true,
        language: "en",
        languageName: TARGET_LANGUAGE,
        results,
        ocrInfo: ocrInfo.length > 0 ? ocrInfo : undefined,
        sourceTexts: sourceTexts.length > 0 ? sourceTexts : undefined,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    } catch (error) {
      logger.error("Translation error", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Anthropic.APIError) {
        return reply
          .code((error.status ?? 500) as number)
          .send({ error: `Claude API error: ${error.message}` });
      }
      return reply.code(500).send({ error: "Translation failed" });
    }
  });

  // ── Chunked upload: append one chunk at its byte offset (idempotent) ─────────
  app.post("/upload", { schema: { tags: ["translate"] } }, async (request, reply) => {
    if (!request.isMultipart())
      return reply.code(400).send({ error: "multipart/form-data required." });
    const { files, fields } = await readMultipart(request);
    const uploadId = fields.uploadId;
    const filename = fields.filename;
    const offset = Number(fields.offset ?? "0");
    const chunk = files[0];
    if (!uploadId || !filename)
      return reply.code(400).send({ error: "uploadId and filename are required." });
    if (!chunk) return reply.code(400).send({ error: "A 'chunk' file part is required." });
    try {
      const size = await writeChunkAt(
        uploadId,
        filename,
        chunk.buffer,
        Number.isFinite(offset) && offset >= 0 ? offset : 0,
      );
      return { ok: true, size };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : "Upload failed." });
    }
  });

  // ── Start a translate/convert background job; returns a jobId to poll ────────
  app.post(
    "/process",
    {
      schema: {
        tags: ["translate"],
        body: {
          type: "object",
          required: ["uploads"],
          properties: {
            mode: { type: "string", enum: ["translate", "convert"] },
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
                  size: { type: "integer", minimum: 0 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        mode?: "translate" | "convert";
        uploads: { uploadId: string; filename: string; size?: number }[];
      };
      const mode = body.mode === "convert" ? "convert" : "translate";

      const jobId = randomUUID();
      const job: Job = { status: "running", events: [], createdAt: Date.now() };
      jobs.set(jobId, job);
      sweepJobs();
      const send: SendFn = (type, data) => {
        job.events.push({ type, data });
      };

      void (async () => {
        try {
          void sweepOldUploads();
          const loaded: { filename: string; buffer: Buffer; size: number }[] = [];
          for (const u of body.uploads) {
            if (typeof u.size === "number") {
              const actual = await uploadSize(u.uploadId, u.filename);
              if (actual !== u.size) {
                throw new Error(
                  'Upload of "' +
                    u.filename +
                    '" is incomplete (' +
                    actual +
                    " of " +
                    u.size +
                    " bytes). Please re-upload.",
                );
              }
            }
            const buffer = await readUpload(u.uploadId, u.filename);
            loaded.push({ filename: u.filename, buffer, size: buffer.length });
          }
          await runTranslateJob(loaded, mode, send);
          job.status = "complete";
        } catch (error) {
          logger.error("Translate/convert error", {
            error: error instanceof Error ? error.message : String(error),
          });
          send("error", {
            message:
              error instanceof Anthropic.APIError
                ? "Claude API error: " + error.message
                : error instanceof Error
                  ? error.message
                  : "Processing failed",
          });
          job.status = "error";
        } finally {
          for (const u of body.uploads) await cleanupUpload(u.uploadId);
        }
      })();

      return reply.send({ jobId });
    },
  );

  // ── Poll a translate/convert job: events since `cursor` + status ─────────────
  app.get(
    "/process/:jobId",
    {
      schema: {
        tags: ["translate"],
        params: {
          type: "object",
          required: ["jobId"],
          properties: { jobId: { type: "string", maxLength: 64 } },
        },
        querystring: { type: "object", properties: { cursor: { type: "integer", minimum: 0 } } },
      },
    },
    async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const cursor = Number((request.query as { cursor?: number }).cursor ?? 0) || 0;
      const job = jobs.get(jobId);
      if (!job) return reply.code(404).send({ error: "Unknown or expired job." });
      return { status: job.status, nextCursor: job.events.length, events: job.events.slice(cursor) };
    },
  );
}
