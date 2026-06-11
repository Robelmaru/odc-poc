import type { FastifyInstance } from "fastify";
import Anthropic from "@anthropic-ai/sdk";
import { timelineQAPrompt } from "../skills/TimelineQA.js";
import { logger } from "../utils/logger.js";
import { logTokenUsage } from "../utils/usage.js";
import { sanitizeConversationHistory } from "../utils/conversation.js";

const anthropic = new Anthropic();

interface TimelineQABody {
  question?: string;
  timeline?: unknown;
  conversationHistory?: unknown;
}

export default async function timelineQA(app: FastifyInstance) {
  app.post(
    "/",
    {
      schema: {
        tags: ["timeline-qa"],
        body: {
          type: "object",
          required: ["question", "timeline"],
          properties: {
            question: { type: "string" },
            timeline: { type: "object" },
            conversationHistory: { type: "array" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const {
          question,
          timeline,
          conversationHistory = [],
        } = (request.body ?? {}) as TimelineQABody;
        if (!question || typeof question !== "string")
          return reply.code(400).send({ error: "Question is required" });
        if (question.length < 5) return reply.code(400).send({ error: "Question is too short" });
        if (question.length > 2000)
          return reply
            .code(400)
            .send({ error: "Question exceeds maximum length of 2,000 characters" });
        if (!timeline || typeof timeline !== "object")
          return reply.code(400).send({ error: "Timeline data is required" });

        logger.info(
          `Timeline Q&A request: "${question.substring(0, 50)}${question.length > 50 ? "..." : ""}"`,
        );

        const systemPrompt = timelineQAPrompt(JSON.stringify(timeline, null, 2));
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
        logTokenUsage("timeline-qa", response.usage);

        const textContent = response.content.find((block) => block.type === "text");
        if (!textContent || textContent.type !== "text")
          return reply.code(500).send({ error: "No response from Claude" });

        logger.info(`Timeline Q&A response generated (${textContent.text.length} characters)`);
        return {
          success: true,
          answer: textContent.text,
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        };
      } catch (error) {
        logger.error("Timeline Q&A error", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Anthropic.APIError) {
          return reply
            .code((error.status ?? 500) as number)
            .send({ error: `Claude API error: ${error.message}` });
        }
        return reply.code(500).send({ error: "Timeline Q&A request failed" });
      }
    },
  );
}
