import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { documentTimelinePrompt, type DocumentTimelineResult } from "../skills/DocumentTimeline.js";
import { timelineMergePrompt } from "../skills/TimelineMerge.js";
import { extractTextFromPdf, chunkText } from "../utils/pdfUtils.js";

const timeline = new Hono();
const anthropic = new Anthropic();

// ── helpers ────────────────────────────────────────────────────────────────

function parseTimelineJson(raw: string): DocumentTimelineResult {
  let text = raw.trim();
  // Strip opening code fence
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "");
  }
  // Strip closing code fence
  if (text.endsWith("```")) {
    text = text.replace(/\n?```\s*$/, "");
  }
  return JSON.parse(text.trim());
}

async function extractChunk(
  filename: string,
  chunkText: string,
  chunkLabel: string,
  additionalContext: string | null
): Promise<DocumentTimelineResult> {
  const parts: Anthropic.ContentBlockParam[] = [
    { type: "text", text: `--- Document: ${filename} ${chunkLabel} ---\n\n${chunkText}\n\n` },
  ];

  if (additionalContext?.trim()) {
    parts.push({ type: "text", text: `--- Additional Context ---\n\n${additionalContext}\n\n` });
  }

  parts.push({
    type: "text",
    text: `Please extract a comprehensive chronological timeline from this document chunk.
When citing sources, use the EXACT filename: ${filename}`,
  });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16384,
    system: documentTimelinePrompt,
    messages: [{ role: "user", content: parts }],
  });

  if (response.stop_reason === "max_tokens") {
    console.log(`    Warning: response truncated for ${filename} ${chunkLabel}, retrying with shorter output instruction...`);
    // Retry asking for a more concise extraction
    parts.pop();
    parts.push({
      type: "text",
      text: `Please extract a chronological timeline from this document chunk. Be CONCISE — only include the most significant events. Return valid JSON.
When citing sources, use the EXACT filename: ${filename}`,
    });
    const retry = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      system: documentTimelinePrompt,
      messages: [{ role: "user", content: parts }],
    });
    const retryBlock = retry.content.find((b) => b.type === "text");
    if (!retryBlock || retryBlock.type !== "text") throw new Error("No response from Claude on retry");
    return parseTimelineJson(retryBlock.text);
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No response from Claude");
  return parseTimelineJson(textBlock.text);
}

async function mergeTwoTimelines(
  a: DocumentTimelineResult,
  b: DocumentTimelineResult
): Promise<DocumentTimelineResult> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16384,
    system: timelineMergePrompt,
    messages: [
      {
        role: "user",
        content: `Merge these 2 partial timelines into one:\n\n${JSON.stringify([a, b], null, 2)}`,
      },
    ],
  });

  if (response.stop_reason === "max_tokens") {
    console.log("    Warning: merge truncated, retrying with concise instruction...");
    const retry = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16384,
      system: timelineMergePrompt,
      messages: [
        {
          role: "user",
          content: `Merge these 2 partial timelines into one. Be CONCISE — deduplicate events and keep only the most significant ones. Return valid JSON.\n\n${JSON.stringify([a, b], null, 2)}`,
        },
      ],
    });
    const retryBlock = retry.content.find((b) => b.type === "text");
    if (!retryBlock || retryBlock.type !== "text") throw new Error("Merge retry failed");
    return parseTimelineJson(retryBlock.text);
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("Merge failed");
  return parseTimelineJson(textBlock.text);
}

async function mergePartialTimelines(
  partials: DocumentTimelineResult[]
): Promise<DocumentTimelineResult> {
  if (partials.length === 1) return partials[0];

  // Merge in pairs to keep output within token limits
  let current = partials;
  while (current.length > 1) {
    const next: DocumentTimelineResult[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        console.log(`    Merging pair ${Math.floor(i / 2) + 1} of ${Math.ceil(current.length / 2)}...`);
        next.push(await mergeTwoTimelines(current[i], current[i + 1]));
      } else {
        next.push(current[i]); // odd one out carries forward
      }
    }
    current = next;
  }
  return current[0];
}

// ── route ──────────────────────────────────────────────────────────────────

timeline.post("/", async (c) => {
  try {
    const contentType = c.req.header("Content-Type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return c.json({ error: "File upload required. Please upload at least one document." }, 400);
    }

    const formData = await c.req.formData();
    const files = formData.getAll("files") as File[];
    const additionalContext = formData.get("additionalContext") as string | null;

    if (files.length === 0) {
      return c.json({ error: "No files uploaded. Please upload at least one document." }, 400);
    }

    console.log(`Processing ${files.length} document(s) for timeline extraction...`);

    // Collect per-document partial timelines
    const allPartials: DocumentTimelineResult[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const ocrResults: { filename: string; quality: string; score: number }[] = [];
    const sourceTexts: { filename: string; text: string }[] = [];

    for (const file of files) {
      console.log(`  Processing: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      let chunks: { label: string; text: string }[] = [];

      if (file.name.endsWith(".pdf")) {
        const { text, pages, ocrQuality, ocrScore } = await extractTextFromPdf(buffer);
        ocrResults.push({ filename: file.name, quality: ocrQuality, score: ocrScore });
        sourceTexts.push({ filename: file.name, text: text.slice(0, 50000) }); // cap at 50k chars for response size
        console.log(`    Extracted ${pages} pages, ${text.length.toLocaleString()} characters (OCR quality: ${ocrQuality}, score: ${ocrScore})`);
        const textChunks = chunkText(text);
        console.log(`    Split into ${textChunks.length} chunk(s)`);
        chunks = textChunks.map((t, i) =>
          textChunks.length > 1
            ? { label: `(Part ${i + 1} of ${textChunks.length})`, text: t }
            : { label: "", text: t }
        );
      } else if (file.name.endsWith(".txt")) {
        const text = await file.text();
        sourceTexts.push({ filename: file.name, text: text.slice(0, 50000) });
        const textChunks = chunkText(text);
        chunks = textChunks.map((t, i) =>
          textChunks.length > 1
            ? { label: `(Part ${i + 1} of ${textChunks.length})`, text: t }
            : { label: "", text: t }
        );
      } else {
        console.log(`    Skipping unsupported file type: ${file.name}`);
        continue;
      }

      // Process each chunk
      const docPartials: DocumentTimelineResult[] = [];
      for (const chunk of chunks) {
        console.log(`    Extracting timeline${chunk.label ? " " + chunk.label : ""}...`);
        const partial = await extractChunk(file.name, chunk.text, chunk.label, additionalContext);
        docPartials.push(partial);
      }

      // Merge chunks for this document if needed
      const docTimeline = await mergePartialTimelines(docPartials);
      allPartials.push(docTimeline);
    }

    if (allPartials.length === 0) {
      return c.json({ error: "No supported files could be processed." }, 400);
    }

    // Final merge across all documents
    console.log(`Merging ${allPartials.length} document timeline(s)...`);
    const finalTimeline = await mergePartialTimelines(allPartials);

    console.log(`Done. ${finalTimeline.timeline?.length ?? 0} events extracted.`);

    return c.json({
      success: true,
      timeline: finalTimeline,
      ocrResults: ocrResults.length > 0 ? ocrResults : undefined,
      sourceTexts: sourceTexts.length > 0 ? sourceTexts : undefined,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
    });
  } catch (error) {
    console.error("Timeline extraction error:", error);

    if (error instanceof Anthropic.APIError) {
      return c.json(
        { error: `Claude API error: ${error.message}`, status: error.status },
        (error.status as number) || 500
      );
    }

    return c.json({ error: "Timeline extraction failed" }, 500);
  }
});

export default timeline;
