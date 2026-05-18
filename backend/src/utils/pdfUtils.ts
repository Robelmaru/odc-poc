import { PDFParse } from "pdf-parse";
import * as pdfPoppler from "pdf-poppler";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PAGES_PER_CHUNK = 60;
const SPARSE_TEXT_THRESHOLD = 50; // pages with fewer chars than this are likely scanned/handwritten
const VISION_CONCURRENCY = 3;

const anthropic = new Anthropic();

export interface PageText {
  pageNum: number;
  text: string;
  visionUsed?: boolean;
  clarity?: number; // 0-100 readability score from Vision
}

export interface PdfExtraction {
  pages: PageText[];
  totalPages: number;
  totalChars: number;
  ocrQuality: string;
  ocrScore: number;
  visionPages: number;
  visionClarity?: number; // average clarity across Vision pages
}

/**
 * Extracts text from a PDF page-by-page.
 * Uses text extraction first, then falls back to Claude Vision for sparse/image pages.
 * Reports a clarity percentage for handwritten/scanned pages.
 */
export async function extractTextFromPdf(
  buffer: Buffer,
  onProgress?: (msg: string) => Promise<void>
): Promise<PdfExtraction> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();

  const allPages: PageText[] = [];
  const rawPages = (result as any).pages || [];

  for (let i = 0; i < rawPages.length; i++) {
    const p = rawPages[i];
    allPages.push({ pageNum: p.num, text: (p.text || "").trim() });
  }

  // Also add pages that had no entry
  const pageNums = new Set(allPages.map((p) => p.pageNum));
  for (let i = 1; i <= result.total; i++) {
    if (!pageNums.has(i)) {
      allPages.push({ pageNum: i, text: "" });
    }
  }
  allPages.sort((a, b) => a.pageNum - b.pageNum);

  // Identify sparse pages (likely scanned/handwritten)
  const sparsePages = allPages.filter((p) => p.text.length < SPARSE_TEXT_THRESHOLD);
  let visionPages = 0;
  let totalClarity = 0;

  if (sparsePages.length > 0) {
    if (onProgress) {
      await onProgress(sparsePages.length + " pages appear to be scanned/handwritten — using Vision OCR...");
    }
    console.log("    Found " + sparsePages.length + " sparse pages, using Claude Vision for OCR...");

    // Write PDF to temp file for pdf-poppler
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "odc-pdf-"));
    const tmpPdf = path.join(tmpDir, "input.pdf");
    fs.writeFileSync(tmpPdf, buffer);

    try {
      const tasks = sparsePages.map((page) => async () => {
        try {
          const imgPrefix = "page-" + page.pageNum;
          await pdfPoppler.convert(tmpPdf, {
            format: "jpeg",
            scale: 1500,
            out_dir: tmpDir,
            out_prefix: imgPrefix,
            page: page.pageNum,
          });

          // Find the output image
          const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(imgPrefix) && f.endsWith(".jpg"));
          if (files.length === 0) return;
          const actualPath = path.join(tmpDir, files[0]!);

          const imgBuffer = fs.readFileSync(actualPath);
          const base64 = imgBuffer.toString("base64");

          const response = await anthropic.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 4096,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/jpeg", data: base64 },
                  },
                  {
                    type: "text",
                    text: `Analyze this document page image. Do two things:

1. Extract ALL visible text — handwritten text, printed text, stamps, signatures, dates, annotations, form fields, checkboxes, and any other visible content. For handwritten text, do your best to decipher it even if unclear.

2. Rate the CLARITY of the page on a scale of 0-100:
   - 0-20: Illegible (cannot make out most text)
   - 21-40: Poor (can read some words but much is unclear)
   - 41-60: Fair (readable with effort, some unclear sections)
   - 61-80: Good (mostly readable, minor unclear areas)
   - 81-100: Excellent (clearly readable)

Return your response in this EXACT format:
CLARITY: [number]
---
[extracted text here]`,
                  },
                ],
              },
            ],
          });

          const textBlock = response.content.find((b) => b.type === "text");
          if (textBlock && textBlock.type === "text" && textBlock.text.trim().length > 0) {
            const responseText = textBlock.text.trim();

            // Parse clarity score and text
            const clarityMatch = responseText.match(/^CLARITY:\s*(\d+)/i);
            let clarity = 50; // default
            let extractedText = responseText;

            if (clarityMatch) {
              clarity = Math.min(100, Math.max(0, parseInt(clarityMatch[1]!, 10)));
              const dividerIdx = responseText.indexOf("---");
              if (dividerIdx !== -1) {
                extractedText = responseText.slice(dividerIdx + 3).trim();
              }
            }

            if (extractedText.length > 0) {
              page.text = extractedText;
              page.visionUsed = true;
              page.clarity = clarity;
              visionPages++;
              totalClarity += clarity;
            }
          }

          // Clean up image file
          try { fs.unlinkSync(actualPath); } catch { /* ignore */ }
        } catch (err) {
          console.log("    Vision OCR failed for page " + page.pageNum + ": " + (err as Error).message.slice(0, 80));
        }
      });

      await runWithConcurrency(tasks, VISION_CONCURRENCY);
    } finally {
      // Clean up temp files
      try {
        const remaining = fs.readdirSync(tmpDir);
        for (const f of remaining) {
          try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
        }
        fs.rmdirSync(tmpDir);
      } catch { /* ignore */ }
    }

    const avgClarity = visionPages > 0 ? Math.round(totalClarity / visionPages) : 0;
    if (onProgress) {
      await onProgress("Vision OCR completed — extracted text from " + visionPages + " pages (avg clarity: " + avgClarity + "%)");
    }
    console.log("    Vision OCR done: " + visionPages + " pages, avg clarity: " + avgClarity + "%");
  }

  // Recalculate stats
  const textPages = allPages.filter((p) => p.text.length > 0);
  const fullText = textPages.map((p) => p.text).join("\n");
  const totalChars = fullText.length;

  // OCR quality estimation
  let ocrQuality = "good";
  let ocrScore = 100;

  if (totalChars < 20) {
    return { pages: textPages, totalPages: result.total, totalChars, ocrQuality: "poor", ocrScore: 0, visionPages, visionClarity: 0 };
  }

  const garbageChars = (fullText.match(/[^\x20-\x7E\n\r\t\u00C0-\u024F]/g) || []).length;
  const repeatedChars = (fullText.match(/(.)\1{4,}/g) || []).length;
  const noSpaceWords = (fullText.match(/[a-zA-Z]{25,}/g) || []).length;
  const brokenWords = (fullText.match(/\b[a-zA-Z]\s[a-zA-Z]\s[a-zA-Z]\b/g) || []).length;

  const garbageRatio = garbageChars / totalChars;
  const issueCount = repeatedChars + noSpaceWords + brokenWords;
  const issueRatio = issueCount / (totalChars / 100);

  ocrScore = 100 - garbageRatio * 200 - issueRatio * 10;
  ocrScore = Math.max(0, Math.min(100, Math.round(ocrScore)));

  if (ocrScore >= 85) ocrQuality = "good";
  else if (ocrScore >= 60) ocrQuality = "fair";
  else ocrQuality = "poor";

  const avgClarity = visionPages > 0 ? Math.round(totalClarity / visionPages) : undefined;
  return { pages: textPages, totalPages: result.total, totalChars, ocrQuality, ocrScore, visionPages, visionClarity: avgClarity };
}

/** Run async tasks with limited concurrency */
async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const idx = next++;
      results[idx] = await tasks[idx]!();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

/**
 * Groups pages into chunks of ~pagesPerChunk pages.
 */
export function chunkByPages(pages: PageText[], pagesPerChunk: number = PAGES_PER_CHUNK): { label: string; text: string; pageRange: string }[] {
  if (pages.length === 0) return [];

  if (pages.length <= pagesPerChunk) {
    return [
      {
        label: "",
        text: pages.map((p) => "--- Page " + p.pageNum + (p.visionUsed ? " [Vision OCR" + (p.clarity != null ? " " + p.clarity + "% clarity" : "") + "]" : "") + " ---\n" + p.text).join("\n\n"),
        pageRange: pages[0]!.pageNum + "-" + pages[pages.length - 1]!.pageNum,
      },
    ];
  }

  const chunks: { label: string; text: string; pageRange: string }[] = [];
  const totalChunks = Math.ceil(pages.length / pagesPerChunk);

  for (let i = 0; i < pages.length; i += pagesPerChunk) {
    const slice = pages.slice(i, i + pagesPerChunk);
    const chunkIndex = Math.floor(i / pagesPerChunk) + 1;
    const firstPage = slice[0]!.pageNum;
    const lastPage = slice[slice.length - 1]!.pageNum;

    chunks.push({
      label: "(Part " + chunkIndex + " of " + totalChunks + ", pages " + firstPage + "\u2013" + lastPage + ")",
      text: slice.map((p) => "--- Page " + p.pageNum + (p.visionUsed ? " [Vision OCR" + (p.clarity != null ? " " + p.clarity + "% clarity" : "") + "]" : "") + " ---\n" + p.text).join("\n\n"),
      pageRange: firstPage + "-" + lastPage,
    });
  }

  return chunks;
}

/**
 * Splits plain text into chunks at paragraph boundaries (for .txt files).
 */
export function chunkText(text: string, maxSize = 80_000): string[] {
  if (text.length <= maxSize) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxSize) {
      if (current) chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
