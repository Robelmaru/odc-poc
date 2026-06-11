import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { translationQAPrompt } from "../skills/TranslationQA.js";
import { logger } from "../utils/logger.js";
import { logTokenUsage } from "../utils/usage.js";
import { sanitizeConversationHistory } from "../utils/conversation.js";

const anthropic = new Anthropic();

interface TranslationQABody {
  question?: string;
  translation?: unknown;
  conversationHistory?: unknown;
}

export default async function translationQA(app: FastifyInstance) {
  app.post(
    "/",
    {
      schema: {
        tags: ["translation-qa"],
        body: {
          type: "object",
          required: ["question", "translation"],
          properties: {
            question: { type: "string" },
            translation: { type: "object" },
            conversationHistory: { type: "array" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const {
          question,
          translation,
          conversationHistory = [],
        } = (request.body ?? {}) as TranslationQABody;
        if (!question || typeof question !== "string")
          return reply.code(400).send({ error: "Question is required" });
        if (question.length < 5) return reply.code(400).send({ error: "Question is too short" });
        if (question.length > 2000)
          return reply.code(400).send({ error: "Question exceeds maximum length" });
        if (!translation || typeof translation !== "object")
          return reply.code(400).send({ error: "Translation data is required" });

        const systemPrompt = translationQAPrompt(JSON.stringify(translation, null, 2));
        const messages: Anthropic.MessageParam[] = [];
        for (const msg of sanitizeConversationHistory(conversationHistory)) {
          messages.push({ role: msg.role, content: msg.content });
        }
        messages.push({ role: "user", content: question });

        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: systemPrompt,
          messages,
        });
        logTokenUsage("translation-qa", response.usage);

        const textContent = response.content.find((block) => block.type === "text");
        if (!textContent || textContent.type !== "text")
          return reply.code(500).send({ error: "No response from Claude" });

        return {
          success: true,
          answer: textContent.text,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        };
      } catch (error) {
        logger.error("Translation Q&A error", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Anthropic.APIError) {
          return reply
            .code((error.status ?? 500) as number)
            .send({ error: "Claude API error: " + error.message });
        }
        return reply.code(500).send({ error: "Translation Q&A request failed" });
      }
    },
  );
}
