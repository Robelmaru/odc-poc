import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { qaPrompt } from "../skills/QA.js";

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

    console.log(`Q&A request: "${question.substring(0, 50)}${question.length > 50 ? '...' : ''}"`);

    // Build messages array with conversation history for context
    const messages: Anthropic.MessageParam[] = [];

    // Add conversation history (limited to last 10 exchanges to manage context)
    const recentHistory = conversationHistory.slice(-20); // 10 exchanges = 20 messages
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

    console.log(`Q&A response generated (${textContent.text.length} characters)`);

    return c.json({
      success: true,
      answer: textContent.text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    });
  } catch (error) {
    console.error("Q&A error:", error);

    if (error instanceof Anthropic.APIError) {
      return c.json(
        {
          error: `Claude API error: ${error.message}`,
          status: error.status,
        },
        error.status as number || 500
      );
    }

    return c.json({ error: "Q&A request failed" }, 500);
  }
});

export default qa;
