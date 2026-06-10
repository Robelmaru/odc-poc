import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { translationQAPrompt } from "../skills/TranslationQA.js";
import { logger } from "../utils/logger.js";
import { logTokenUsage } from "../utils/usage.js";
import { sanitizeConversationHistory } from "../utils/conversation.js";

const translationQA = new Hono();
const anthropic = new Anthropic();

translationQA.post("/", async (c) => {
  try {
    const { question, translation, conversationHistory = [] } = await c.req.json();

    if (!question || typeof question !== "string")
      return c.json({ error: "Question is required" }, 400);
    if (question.length < 5) return c.json({ error: "Question is too short" }, 400);
    if (question.length > 2000) return c.json({ error: "Question exceeds maximum length" }, 400);
    if (!translation || typeof translation !== "object")
      return c.json({ error: "Translation data is required" }, 400);

    const translationJson = JSON.stringify(translation, null, 2);
    const systemPrompt = translationQAPrompt(translationJson);

    const messages: Anthropic.MessageParam[] = [];
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
    logTokenUsage("translation-qa", response.usage);

    const textContent = response.content.find((block) => block.type === "text");
    if (!textContent || textContent.type !== "text")
      return c.json({ error: "No response from Claude" }, 500);

    return c.json({
      success: true,
      answer: textContent.text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    });
  } catch (error) {
    logger.error("Translation Q&A error", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Anthropic.APIError) {
      return c.json(
        { error: "Claude API error: " + error.message },
        (error.status as 400 | 500) || 500,
      );
    }
    return c.json({ error: "Translation Q&A request failed" }, 500);
  }
});

export default translationQA;
