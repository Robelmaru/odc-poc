import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { translatePrompt, SUPPORTED_LANGUAGES, type LanguageCode } from "../skills/Translate.js";
import { extractTextFromPdf, chunkText } from "../utils/pdfUtils.js";

const translate = new Hono();
const anthropic = new Anthropic();

async function translateChunk(text: string, targetLanguage: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    system: translatePrompt(targetLanguage),
    messages: [{ role: "user", content: text }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No response from Claude");
  return textBlock.text;
}

translate.post("/", async (c) => {
  try {
    const contentType = c.req.header("Content-Type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return c.json({ error: "File upload required." }, 400);
    }

    const formData = await c.req.formData();
    const files = formData.getAll("files") as File[];
    const language = formData.get("language") as string | null;

    if (files.length === 0) {
      return c.json({ error: "Please upload at least one document." }, 400);
    }

    if (!language || !(language in SUPPORTED_LANGUAGES)) {
      return c.json({ error: "Please select a target language." }, 400);
    }

    const targetLanguage = SUPPORTED_LANGUAGES[language as LanguageCode];
    console.log(`Translating ${files.length} file(s) to ${targetLanguage}...`);

    const results: { filename: string; translation: string; pages?: number }[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const file of files) {
      console.log(`  Processing: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      let fullText = "";
      let pages: number | undefined;

      if (file.name.endsWith(".pdf")) {
        const extracted = await extractTextFromPdf(buffer);
        fullText = extracted.text;
        pages = extracted.pages;
        console.log(`    Extracted ${pages} pages, ${fullText.length.toLocaleString()} characters`);
      } else if (file.name.endsWith(".txt")) {
        fullText = await file.text();
      } else {
        console.log(`    Skipping unsupported file type: ${file.name}`);
        continue;
      }

      const chunks = chunkText(fullText);
      console.log(`    Translating in ${chunks.length} chunk(s)...`);

      const translatedChunks: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        console.log(`    Chunk ${i + 1}/${chunks.length}...`);
        const translated = await translateChunk(chunks[i], targetLanguage);
        translatedChunks.push(translated);
      }

      results.push({
        filename: file.name,
        translation: translatedChunks.join("\n\n"),
        pages,
      });
    }

    if (results.length === 0) {
      return c.json({ error: "No supported files could be processed." }, 400);
    }

    console.log(`Translation complete for ${results.length} file(s).`);

    return c.json({
      success: true,
      language,
      languageName: targetLanguage,
      results,
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    });
  } catch (error) {
    console.error("Translation error:", error);

    if (error instanceof Anthropic.APIError) {
      return c.json(
        { error: `Claude API error: ${error.message}` },
        (error.status as number) || 500
      );
    }

    return c.json({ error: "Translation failed" }, 500);
  }
});

export default translate;
