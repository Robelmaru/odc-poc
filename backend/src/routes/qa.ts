import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import Anthropic from "@anthropic-ai/sdk";
import { qaPrompt } from "../skills/QA.js";
import { logger } from "../utils/logger.js";
import { sanitizeConversationHistory } from "../utils/conversation.js";

const qa = new Hono();

const anthropic = new Anthropic();

interface QARequest {
  question: string;
  conversationHistory?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

qa.post("/", async (c) => {
  try {
    const { question, conversationHistory = [] } = await c.req.json<QARequest>();

    if (!question || typeof question !== "string") {
      return c.json({ error: "Question is required" }, 400);
    }

    if (question.length < 5) {
      return c.json({ error: "Question is too short" }, 400);
    }

    if (question.length > 2000) {
      return c.json({ error: "Question exceeds maximum length of 2,000 characters" }, 400);
    }

    logger.info(`Q&A request: "${question.substring(0, 50)}${question.length > 50 ? "..." : ""}"`);

    // Build messages array with conversation history for context
    const messages: Anthropic.MessageParam[] = [];

    // Add conversation history (validated + bounded: role, length, count)
    const recentHistory = sanitizeConversationHistory(conversationHistory);
    for (const msg of recentHistory) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }

    // Add the current question
    messages.push({
      role: "user",
      content: question,
    });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: qaPrompt,
      messages,
    });

    // Extract text response
    const textContent = response.content.find((block) => block.type === "text");
    if (!textContent || textContent.type !== "text") {
      return c.json({ error: "No response from Claude" }, 500);
    }

    logger.info(`Q&A response generated (${textContent.text.length} characters)`);

    return c.json({
      success: true,
      answer: textContent.text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    });
  } catch (error) {
    logger.error("Q&A error", { error: error instanceof Error ? error.message : String(error) });

    if (error instanceof Anthropic.APIError) {
      return c.json(
        {
          error: `Claude API error: ${error.message}`,
          status: error.status,
        },
        (error.status ?? 500) as ContentfulStatusCode,
      );
    }

    return c.json({ error: "Q&A request failed" }, 500);
  }
});

export default qa;
