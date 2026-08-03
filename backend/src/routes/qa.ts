import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { qaPrompt } from "../skills/QA.js";
import { logger } from "../utils/logger.js";
import { logTokenUsage } from "../utils/usage.js";
import { sanitizeConversationHistory } from "../utils/conversation.js";

const anthropic = new Anthropic();

interface QABody {
  question?: string;
  conversationHistory?: unknown;
}

export default async function qa(app: FastifyInstance) {
  app.post(
    "/",
    {
      schema: {
        tags: ["qa"],
        body: {
          type: "object",
          required: ["question"],
          properties: {
            question: { type: "string" },
            conversationHistory: { type: "array" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { question, conversationHistory = [] } = (request.body ?? {}) as QABody;
        if (!question || typeof question !== "string")
          return reply.code(400).send({ error: "Question is required" });
        if (question.length < 5) return reply.code(400).send({ error: "Question is too short" });
        if (question.length > 2000)
          return reply
            .code(400)
            .send({ error: "Question exceeds maximum length of 2,000 characters" });

        // Log metadata only — questions can contain case PII (OPS-015).
        logger.info(`Q&A request received (${question.length} characters)`);

        const messages: Anthropic.MessageParam[] = [];
        for (const msg of sanitizeConversationHistory(conversationHistory)) {
          messages.push({ role: msg.role, content: msg.content });
        }
        messages.push({ role: "user", content: question });

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: qaPrompt,
          messages,
        });
        logTokenUsage("qa", response.usage);

        const textContent = response.content.find((block) => block.type === "text");
        if (!textContent || textContent.type !== "text")
          return reply.code(500).send({ error: "No response from Claude" });

        logger.info(`Q&A response generated (${textContent.text.length} characters)`);
        return {
          success: true,
          answer: textContent.text,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        };
      } catch (error) {
        logger.error("Q&A error", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Anthropic.APIError) {
          return reply
            .code((error.status ?? 500) as number)
            .send({ error: `Claude API error: ${error.message}` });
        }
        return reply.code(500).send({ error: "Q&A request failed" });
      }
    },
  );
}
