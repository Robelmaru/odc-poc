import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import Anthropic from "@anthropic-ai/sdk";
import { analyzeComplaintPrompt, type AnalysisResult } from "../skills/AnalyzeComplaint.js";
import { AnalysisResultSchema } from "../schemas/claudeResults.js";
import { logger } from "../utils/logger.js";
import { logTokenUsage } from "../utils/usage.js";

const analyze = new Hono();

const anthropic = new Anthropic();

analyze.post("/", async (c) => {
  try {
    const contentType = c.req.header("Content-Type") || "";

    let messageContent: Anthropic.MessageCreateParams["messages"][0]["content"];

    if (contentType.includes("multipart/form-data")) {
      // Handle file upload(s)
      const formData = await c.req.formData();
      const files = formData.getAll("files") as File[];
      const additionalText = formData.get("additionalText") as string | null;

      if (files.length === 0) {
        return c.json({ error: "No files uploaded" }, 400);
      }

      logger.info(`Processing ${files.length} file(s)...`);

      // Build content array with all documents
      const contentParts: Anthropic.ContentBlockParam[] = [];

      // Collect filenames for the instruction
      const fileNames: string[] = [];

      // Process each file
      for (const file of files) {
        logger.info(`  - ${file.name} (${file.size} bytes)`);
        fileNames.push(file.name);

        if (file.name.endsWith(".pdf")) {
          // Add filename label before the PDF
          contentParts.push({
            type: "text" as const,
            text: `--- Document: ${file.name} ---`,
          });

          // Add PDF document
          const arrayBuffer = await file.arrayBuffer();
          const base64Data = Buffer.from(arrayBuffer).toString("base64");

          contentParts.push({
            type: "document" as const,
            source: {
              type: "base64" as const,
              media_type: "application/pdf" as const,
              data: base64Data,
            },
          });
        } else if (file.name.endsWith(".txt")) {
          // Add text content
          const text = await file.text();
          contentParts.push({
            type: "text" as const,
            text: `--- Document: ${file.name} ---\n\n${text}\n\n`,
          });
        } else {
          logger.info(`    Skipping unsupported file type: ${file.name}`);
        }
      }

      // Add any additional text from the textarea
      if (additionalText && additionalText.trim()) {
        contentParts.push({
          type: "text" as const,
          text: `--- Additional Context ---\n\n${additionalText}\n\n`,
        });
      }

      // Add the analysis instruction with explicit filename list
      contentParts.push({
        type: "text" as const,
        text: `Please analyze ${files.length > 1 ? "these complaint documents together as a single case" : "this complaint document"}. If there are multiple documents, treat them as related to the same matter and cross-reference information between them.

IMPORTANT: The uploaded documents are named EXACTLY as follows:
${fileNames.map((name, i) => `${i + 1}. ${name}`).join("\n")}

When citing sources in the timeline, you MUST use these EXACT filenames. Do not use any other names, titles, or references from within the document content.`,
      });

      messageContent = contentParts;
    } else {
      // Handle JSON text input
      const { complaint } = await c.req.json<{ complaint: string }>();

      if (!complaint || typeof complaint !== "string") {
        return c.json({ error: "Complaint text is required" }, 400);
      }

      if (complaint.length < 50) {
        return c.json({ error: "Complaint text is too short. Please provide more details." }, 400);
      }

      if (complaint.length > 50000) {
        return c.json({ error: "Complaint text exceeds maximum length of 50,000 characters" }, 400);
      }

      logger.info(`Analyzing complaint text (${complaint.length} characters)...`);
      messageContent = `Please analyze the following complaint:\n\n${complaint}`;
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: analyzeComplaintPrompt,
      messages: [
        {
          role: "user",
          content: messageContent,
        },
      ],
    });
    logTokenUsage("analyze", response.usage);

    // Extract text response
    const textContent = response.content.find((block) => block.type === "text");
    if (!textContent || textContent.type !== "text") {
      return c.json({ error: "No response from Claude" }, 500);
    }

    // Parse JSON response
    let analysis: AnalysisResult;
    try {
      // Claude sometimes wraps JSON in markdown code blocks
      let jsonText = textContent.text;
      const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch?.[1]) {
        jsonText = jsonMatch[1];
      }
      // Validate the model's JSON shape before returning/saving it (TS-001).
      analysis = AnalysisResultSchema.parse(JSON.parse(jsonText)) as unknown as AnalysisResult;
    } catch (parseError) {
      logger.error("Failed to parse Claude response as JSON", {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        preview: textContent.text.slice(0, 120),
      });
      return c.json(
        {
          error: "Failed to parse analysis response",
          rawResponse: textContent.text,
        },
        500,
      );
    }

    logger.info(
      `Analysis complete. Found ${analysis.potentialViolations?.length || 0} potential violations.`,
    );

    return c.json({
      success: true,
      analysis,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    });
  } catch (error) {
    logger.error("Analysis error", {
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof Anthropic.APIError) {
      return c.json(
        {
          error: `Claude API error: ${error.message}`,
          status: error.status,
        },
        (error.status ?? 500) as ContentfulStatusCode,
      );
    }

    return c.json({ error: "Analysis failed" }, 500);
  }
});

export default analyze;
