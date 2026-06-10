import { PDFParse } from "pdf-parse";
import * as pdfPoppler from "pdf-poppler";
import Anthropic from "@anthropic-ai/sdk";
import { createWorker } from "tesseract.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "./logger.js";

const PAGES_PER_CHUNK = 60;
const SPARSE_TEXT_THRESHOLD = 50; // pages with fewer chars than this are likely scanned/handwritten
// OCR fan-out. Configurable so large scanned productions can be sped up without a
// code change; bounded to keep clear of Anthropic rate limits.
const VISION_CONCURRENCY = Math.min(12, Math.max(1, Number(process.env.OCR_CONCURRENCY) || 6));

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
  ocrPages: number; // pages OCR'd by any engine (local Tesseract or Vision)
  visionPages: number; // subset of ocrPages that used the Claude Vision fallback
  visionClarity?: number; // average clarity/confidence across OCR'd pages
}

/**
 * Extracts text from a PDF page-by-page.
 * Uses text extraction first, then falls back to Claude Vision for sparse/image pages.
 * Reports a clarity percentage for handwritten/scanned pages.
 */
export async function extractTextFromPdf(
  buffer: Buffer,
  onProgress?: (msg: string) => Promise<void>,
  maxPages?: number,
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

  // Optional cap: only process the first N pages (used by quick comparisons so a
  // huge document doesn't get fully OCR'd twice). totalPages still reflects the
  // true document size so callers can report that it was sampled.
  if (maxPages && maxPages > 0 && allPages.length > maxPages) {
    allPages.length = maxPages;
  }

  // Identify sparse pages (likely scanned/handwritten)
  const sparsePages = allPages.filter((p) => p.text.length < SPARSE_TEXT_THRESHOLD);
  let visionPages = 0; // pages that used the Claude Vision FALLBACK
  let ocrPages = 0; // pages OCR'd by any engine (local Tesseract or Vision)
  let totalClarity = 0;

  if (sparsePages.length > 0) {
    if (onProgress) {
      await onProgress(sparsePages.length + " pages appear to be scanned — running OCR...");
    }
    logger.debug("    Found " + sparsePages.length + " sparse pages, running OCR...");

    // Write PDF to temp file for pdf-poppler
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "odc-pdf-"));
    const tmpPdf = path.join(tmpDir, "input.pdf");
    fs.writeFileSync(tmpPdf, buffer);

    let processed = 0;
    const totalSparse = sparsePages.length;

    // OCR strategy: local Tesseract first (cheap, offline), Claude Vision as a
    // fallback only for pages Tesseract reads with low confidence. Set
    // OCR_ENGINE=vision to force Vision for every page.
    const ocrEngine = (process.env.OCR_ENGINE || "local").toLowerCase();
    const LOCAL_CONF_MIN = Number(process.env.OCR_LOCAL_CONF_MIN) || 55;
    const poolSize = Math.max(1, Math.min(VISION_CONCURRENCY, sparsePages.length));

    // Local Tesseract worker pool using the bundled model (no network at runtime).
    let tessPool: any[] = [];
    if (ocrEngine !== "vision") {
      try {
        const tessdata = path.resolve(process.cwd(), "data", "tessdata");
        tessPool = await Promise.all(
          Array.from({ length: poolSize }, () =>
            createWorker("eng", 1, {
              langPath: tessdata,
              cachePath: tessdata,
              gzip: true,
              cacheMethod: "none",
            }),
          ),
        );
      } catch (e) {
        logger.debug(
          "    Local OCR unavailable (" + (e as Error).message.slice(0, 80) + ") — using Vision.",
        );
        tessPool = [];
      }
    }
    const localAvailable = tessPool.length > 0;
    const available = [...tessPool]; // simple worker stack; pool size === concurrency

    // Claude Vision OCR for a single rendered page (fallback / forced engine).
    const visionOcr = async (base64: string): Promise<{ text: string; clarity: number } | null> => {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
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
      const tb = response.content.find((b) => b.type === "text");
      if (!tb || tb.type !== "text") return null;
      const rt = tb.text.trim();
      const cm = rt.match(/^CLARITY:\s*(\d+)/i);
      let clarity = 50;
      let text = rt;
      if (cm) {
        clarity = Math.min(100, Math.max(0, parseInt(cm[1]!, 10)));
        const di = rt.indexOf("---");
        if (di !== -1) text = rt.slice(di + 3).trim();
      }
      return { text, clarity };
    };

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
          const files = fs
            .readdirSync(tmpDir)
            .filter((f) => f.startsWith(imgPrefix) && f.endsWith(".jpg"));
          if (files.length === 0) return;
          const actualPath = path.join(tmpDir, files[0]!);

          let text = "";
          let score = 0;
          let usedVision = false;

          // 1) Local Tesseract OCR first.
          if (localAvailable) {
            const tess = available.pop();
            if (tess) {
              try {
                const r = await tess.recognize(actualPath);
                text = (r.data.text || "").trim();
                score = Math.round(r.data.confidence || 0);
              } catch {
                /* fall through to Vision */
              } finally {
                available.push(tess);
              }
            }
          }

          // 2) Vision fallback when local is unavailable, too short, or low-confidence.
          const localGood = localAvailable && text.length >= 40 && score >= LOCAL_CONF_MIN;
          if (!localGood) {
            try {
              const base64 = fs.readFileSync(actualPath).toString("base64");
              const v = await visionOcr(base64);
              if (v && v.text.length > 0) {
                text = v.text;
                score = v.clarity;
                usedVision = true;
              }
            } catch (err) {
              logger.debug(
                "    Vision OCR failed for page " +
                  page.pageNum +
                  ": " +
                  (err as Error).message.slice(0, 80),
              );
            }
          }

          if (text.length > 0) {
            page.text = text;
            page.visionUsed = true;
            page.clarity = score;
            ocrPages++;
            totalClarity += score;
            if (usedVision) visionPages++;
          }

          try {
            fs.unlinkSync(actualPath);
          } catch {
            /* ignore */
          }
        } catch (err) {
          logger.debug(
            "    OCR failed for page " + page.pageNum + ": " + (err as Error).message.slice(0, 80),
          );
        } finally {
          processed++;
          if (onProgress && (processed === totalSparse || processed % 5 === 0)) {
            await onProgress(
              "OCR " +
                processed +
                " / " +
                totalSparse +
                " scanned pages" +
                (visionPages > 0 ? " (" + visionPages + " via Vision)" : "") +
                "...",
            );
          }
        }
      });

      await runWithConcurrency(tasks, localAvailable ? tessPool.length : VISION_CONCURRENCY);
    } finally {
      for (const w of tessPool) {
        try {
          await w.terminate();
        } catch {
          /* ignore */
        }
      }
      // Clean up temp files
      try {
        const remaining = fs.readdirSync(tmpDir);
        for (const f of remaining) {
          try {
            fs.unlinkSync(path.join(tmpDir, f));
          } catch {
            /* ignore */
          }
        }
        fs.rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
    }

    const avgClarity = ocrPages > 0 ? Math.round(totalClarity / ocrPages) : 0;
    const engineLabel = localAvailable
      ? "local Tesseract" + (visionPages > 0 ? " + " + visionPages + " via Vision" : "")
      : "Vision";
    if (onProgress) {
      await onProgress(
        "OCR completed — extracted text from " +
          ocrPages +
          " pages via " +
          engineLabel +
          " (avg clarity/confidence: " +
          avgClarity +
          "%)",
      );
    }
    logger.debug(
      "    OCR done: " +
        ocrPages +
        " pages via " +
        engineLabel +
        ", avg clarity " +
        avgClarity +
        "%",
    );
  }

  // Recalculate stats
  const textPages = allPages.filter((p) => p.text.length > 0);
  const fullText = textPages.map((p) => p.text).join("\n");
  const totalChars = fullText.length;

  // OCR quality estimation
  let ocrQuality = "good";
  let ocrScore = 100;

  if (totalChars < 20) {
    return {
      pages: textPages,
      totalPages: result.total,
      totalChars,
      ocrQuality: "poor",
      ocrScore: 0,
      ocrPages,
      visionPages,
      visionClarity: 0,
    };
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

  const avgClarity = ocrPages > 0 ? Math.round(totalClarity / ocrPages) : undefined;
  return {
    pages: textPages,
    totalPages: result.total,
    totalChars,
    ocrQuality,
    ocrScore,
    ocrPages,
    visionPages,
    visionClarity: avgClarity,
  };
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
export function chunkByPages(
  pages: PageText[],
  pagesPerChunk: number = PAGES_PER_CHUNK,
): { label: string; text: string; pageRange: string }[] {
  if (pages.length === 0) return [];

  if (pages.length <= pagesPerChunk) {
    return [
      {
        label: "",
        text: pages
          .map(
            (p) =>
              "--- Page " +
              p.pageNum +
              (p.visionUsed
                ? " [Vision OCR" + (p.clarity != null ? " " + p.clarity + "% clarity" : "") + "]"
                : "") +
              " ---\n" +
              p.text,
          )
          .join("\n\n"),
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
      label:
        "(Part " +
        chunkIndex +
        " of " +
        totalChunks +
        ", pages " +
        firstPage +
        "\u2013" +
        lastPage +
        ")",
      text: slice
        .map(
          (p) =>
            "--- Page " +
            p.pageNum +
            (p.visionUsed
              ? " [Vision OCR" + (p.clarity != null ? " " + p.clarity + "% clarity" : "") + "]"
              : "") +
            " ---\n" +
            p.text,
        )
        .join("\n\n"),
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
