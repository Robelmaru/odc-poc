import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import Anthropic from "@anthropic-ai/sdk";
import { timelineQAPrompt } from "../skills/TimelineQA.js";
import { logger } from "../utils/logger.js";
import { logTokenUsage } from "../utils/usage.js";
import { sanitizeConversationHistory } from "../utils/conversation.js";

const timelineQA = new Hono();

const anthropic = new Anthropic();

interface TimelineQARequest {
  question: string;
  timeline: object;
  conversationHistory?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

timelineQA.post("/", async (c) => {
  try {
    const { question, timeline, conversationHistory = [] } = await c.req.json<TimelineQARequest>();

    if (!question || typeof question !== "string") {
      return c.json({ error: "Question is required" }, 400);
    }

    if (question.length < 5) {
      return c.json({ error: "Question is too short" }, 400);
    }

    if (question.length > 2000) {
      return c.json({ error: "Question exceeds maximum length of 2,000 characters" }, 400);
    }

    if (!timeline || typeof timeline !== "object") {
      return c.json({ error: "Timeline data is required" }, 400);
    }

    logger.info(
      `Timeline Q&A request: "${question.substring(0, 50)}${question.length > 50 ? "..." : ""}"`,
    );

    const timelineJson = JSON.stringify(timeline, null, 2);
    const systemPrompt = timelineQAPrompt(timelineJson);

    const messages: Anthropic.MessageParam[] = [];

    // Add conversation history (validated + bounded: role, length, count)
    const recentHistory = sanitizeConversationHistory(conversationHistory);
    for (const msg of recentHistory) {
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
    if (!textContent || textContent.type !== "text") {
      return c.json({ error: "No response from Claude" }, 500);
    }

    logger.info(`Timeline Q&A response generated (${textContent.text.length} characters)`);

    return c.json({
      success: true,
      answer: textContent.text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    });
  } catch (error) {
    logger.error("Timeline Q&A error", {
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof Anthropic.APIError) {
      return c.json(
        { error: `Claude API error: ${error.message}`, status: error.status },
        (error.status ?? 500) as ContentfulStatusCode,
      );
    }

    return c.json({ error: "Timeline Q&A request failed" }, 500);
  }
});

export default timelineQA;
