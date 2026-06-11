import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { translatePrompt, SUPPORTED_LANGUAGES, type LanguageCode } from "../skills/Translate.js";
import { extractTextFromPdf, chunkText } from "../utils/pdfUtils.js";
import { logger } from "../utils/logger.js";
import { logTokenUsage } from "../utils/usage.js";
import { readMultipart } from "../utils/multipart.js";

const anthropic = new Anthropic();

async function translateChunk(text: string, targetLanguage: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    system: translatePrompt(targetLanguage),
    messages: [{ role: "user", content: text }],
  });
  logTokenUsage("translate", response.usage);
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No response from Claude");
  return textBlock.text;
}

export default async function translate(app: FastifyInstance) {
  app.post("/", { schema: { tags: ["translate"] } }, async (request, reply) => {
    try {
      if (!request.isMultipart()) return reply.code(400).send({ error: "File upload required." });
      const { files, fields } = await readMultipart(request);
      const language = fields.language ?? null;

      if (files.length === 0)
        return reply.code(400).send({ error: "Please upload at least one document." });
      if (!language || !(language in SUPPORTED_LANGUAGES))
        return reply.code(400).send({ error: "Please select a target language." });

      const targetLanguage = SUPPORTED_LANGUAGES[language as LanguageCode];
      logger.info(`Translating ${files.length} file(s) to ${targetLanguage}...`);

      const results: { filename: string; translation: string; pages?: number }[] = [];
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

        const chunks = chunkText(fullText);
        logger.info(`    Translating in ${chunks.length} chunk(s)...`);
        const translatedChunks: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          logger.info(`    Chunk ${i + 1}/${chunks.length}...`);
          translatedChunks.push(await translateChunk(chunks[i]!, targetLanguage!));
        }
        results.push({
          filename: file.filename,
          translation: translatedChunks.join("\n\n"),
          pages,
        });
      }

      if (results.length === 0)
        return reply.code(400).send({ error: "No supported files could be processed." });

      logger.info(`Translation complete for ${results.length} file(s).`);
      return {
        success: true,
        language,
        languageName: targetLanguage,
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
}
