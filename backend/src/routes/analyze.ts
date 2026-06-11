import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { analyzeComplaintPrompt, type AnalysisResult } from "../skills/AnalyzeComplaint.js";
import { AnalysisResultSchema } from "../schemas/claudeResults.js";
import { logger } from "../utils/logger.js";
import { logTokenUsage } from "../utils/usage.js";
import { readMultipart } from "../utils/multipart.js";

const anthropic = new Anthropic();

export default async function analyze(app: FastifyInstance) {
  app.post("/", { schema: { tags: ["analyze"] } }, async (request, reply) => {
    try {
      let messageContent: Anthropic.MessageCreateParams["messages"][0]["content"];

      if (request.isMultipart()) {
        const { files, fields } = await readMultipart(request);
        if (files.length === 0) return reply.code(400).send({ error: "No files uploaded" });
        const additionalText = fields.additionalText ?? null;

        logger.info(`Processing ${files.length} file(s)...`);
        const contentParts: Anthropic.ContentBlockParam[] = [];
        const fileNames: string[] = [];

        for (const file of files) {
          logger.info(`  - ${file.filename} (${file.size} bytes)`);
          fileNames.push(file.filename);
          if (file.filename.endsWith(".pdf")) {
            contentParts.push({
              type: "text" as const,
              text: `--- Document: ${file.filename} ---`,
            });
            contentParts.push({
              type: "document" as const,
              source: {
                type: "base64" as const,
                media_type: "application/pdf" as const,
                data: file.buffer.toString("base64"),
              },
            });
          } else if (file.filename.endsWith(".txt")) {
            contentParts.push({
              type: "text" as const,
              text: `--- Document: ${file.filename} ---\n\n${file.buffer.toString("utf8")}\n\n`,
            });
          } else {
            logger.info(`    Skipping unsupported file type: ${file.filename}`);
          }
        }

        if (additionalText && additionalText.trim()) {
          contentParts.push({
            type: "text" as const,
            text: `--- Additional Context ---\n\n${additionalText}\n\n`,
          });
        }

        contentParts.push({
          type: "text" as const,
          text: `Please analyze ${files.length > 1 ? "these complaint documents together as a single case" : "this complaint document"}. If there are multiple documents, treat them as related to the same matter and cross-reference information between them.

IMPORTANT: The uploaded documents are named EXACTLY as follows:
${fileNames.map((name, i) => `${i + 1}. ${name}`).join("\n")}

When citing sources in the timeline, you MUST use these EXACT filenames. Do not use any other names, titles, or references from within the document content.`,
        });

        messageContent = contentParts;
      } else {
        const { complaint } = (request.body ?? {}) as { complaint?: string };
        if (!complaint || typeof complaint !== "string")
          return reply.code(400).send({ error: "Complaint text is required" });
        if (complaint.length < 50)
          return reply
            .code(400)
            .send({ error: "Complaint text is too short. Please provide more details." });
        if (complaint.length > 50000)
          return reply
            .code(400)
            .send({ error: "Complaint text exceeds maximum length of 50,000 characters" });
        logger.info(`Analyzing complaint text (${complaint.length} characters)...`);
        messageContent = `Please analyze the following complaint:\n\n${complaint}`;
      }

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8192,
        system: analyzeComplaintPrompt,
        messages: [{ role: "user", content: messageContent }],
      });
      logTokenUsage("analyze", response.usage);

      const textContent = response.content.find((block) => block.type === "text");
      if (!textContent || textContent.type !== "text")
        return reply.code(500).send({ error: "No response from Claude" });

      let analysis: AnalysisResult;
      try {
        let jsonText = textContent.text;
        const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch?.[1]) jsonText = jsonMatch[1];
        analysis = AnalysisResultSchema.parse(JSON.parse(jsonText)) as unknown as AnalysisResult;
      } catch (parseError) {
        logger.error("Failed to parse Claude response as JSON", {
          error: parseError instanceof Error ? parseError.message : String(parseError),
          preview: textContent.text.slice(0, 120),
        });
        return reply.code(500).send({ error: "Failed to parse analysis response" });
      }

      logger.info(
        `Analysis complete. Found ${analysis.potentialViolations?.length || 0} potential violations.`,
      );
      return {
        success: true,
        analysis,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      logger.error("Analysis error", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Anthropic.APIError) {
        return reply
          .code((error.status ?? 500) as number)
          .send({ error: `Claude API error: ${error.message}` });
      }
      return reply.code(500).send({ error: "Analysis failed" });
    }
  });
}
