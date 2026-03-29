import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { timelineQAPrompt } from "../skills/TimelineQA.js";

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

    console.log(`Timeline Q&A request: "${question.substring(0, 50)}${question.length > 50 ? "..." : ""}"`);

    const timelineJson = JSON.stringify(timeline, null, 2);
    const systemPrompt = timelineQAPrompt(timelineJson);

    const messages: Anthropic.MessageParam[] = [];

    // Add last 10 exchanges of conversation history
    const recentHistory = conversationHistory.slice(-20);
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

    const textContent = response.content.find((block) => block.type === "text");
    if (!textContent || textContent.type !== "text") {
      return c.json({ error: "No response from Claude" }, 500);
    }

    console.log(`Timeline Q&A response generated (${textContent.text.length} characters)`);

    return c.json({
      success: true,
      answer: textContent.text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    });
  } catch (error) {
    console.error("Timeline Q&A error:", error);

    if (error instanceof Anthropic.APIError) {
      return c.json(
        { error: `Claude API error: ${error.message}`, status: error.status },
        (error.status as number) || 500
      );
    }

    return c.json({ error: "Timeline Q&A request failed" }, 500);
  }
});

export default timelineQA;
