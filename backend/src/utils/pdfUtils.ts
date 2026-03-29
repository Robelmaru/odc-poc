import { PDFParse } from "pdf-parse";

const CHUNK_SIZE = 80_000; // ~20k tokens — smaller chunks to avoid output truncation

export async function extractTextFromPdf(buffer: Buffer): Promise<{ text: string; pages: number; ocrQuality: string; ocrScore: number }> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();

  // Estimate OCR quality based on character patterns
  const text = result.text;
  const totalChars = text.length;

  if (totalChars < 20) {
    return { text: result.text, pages: result.total, ocrQuality: 'poor', ocrScore: 0 };
  }

  // Count suspicious patterns typical of bad OCR
  const garbageChars = (text.match(/[^\x20-\x7E\n\r\t\u00C0-\u024F]/g) || []).length;
  const repeatedChars = (text.match(/(.)\1{4,}/g) || []).length; // 5+ repeated chars
  const noSpaceWords = (text.match(/[a-zA-Z]{25,}/g) || []).length; // very long "words"
  const brokenWords = (text.match(/\b[a-zA-Z]\s[a-zA-Z]\s[a-zA-Z]\b/g) || []).length; // single chars with spaces

  const garbageRatio = garbageChars / totalChars;
  const issueCount = repeatedChars + noSpaceWords + brokenWords;
  const issueRatio = issueCount / (totalChars / 100);

  let score = 100;
  score -= garbageRatio * 200;
  score -= issueRatio * 10;
  score = Math.max(0, Math.min(100, Math.round(score)));

  let quality: string;
  if (score >= 85) quality = 'good';
  else if (score >= 60) quality = 'fair';
  else quality = 'poor';

  return { text: result.text, pages: result.total, ocrQuality: quality, ocrScore: score };
}

/**
 * Splits text into chunks at paragraph boundaries, each at most CHUNK_SIZE characters.
 */
export function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > CHUNK_SIZE) {
      if (current) chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? "\n\n" : "") + para;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
