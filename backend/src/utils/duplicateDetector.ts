// Duplicate content-block detector for the Document Insight analyzer.
//
// Operates deterministically on the extracted per-page text (so it works even on
// scanned/OCR'd productions and across multiple files). Finds:
//   - EXACT duplicate blocks (identical normalized text), and
//   - NEAR duplicate blocks (high word-shingle Jaccard overlap)
// within a single file or between two files. Page-level blocks align with the
// PDF page-navigation UX (each finding links to a page).

export interface DuplicateBlock {
  filename: string;
  page: number | null;
  preview: string;
}

export interface DuplicateMatch {
  type: "EXACT" | "NEAR";
  similarity: number; // 0–1
  scope: "within-file" | "cross-file";
  blocks: DuplicateBlock[]; // 2+ locations of the same/similar content
}

export interface DuplicateResult {
  matches: DuplicateMatch[];
  blocksScanned: number;
  note?: string; // populated when scanning was bounded for performance
}

export interface FilePages {
  filename: string;
  pages: { pageNum: number | null; text: string }[];
}

const MIN_BLOCK_CHARS = 120; // ignore short/boilerplate pages
const SHINGLE_K = 4;
const NEAR_THRESHOLD = 0.82;
const MAX_NEAR_COMPARISONS = 200_000; // bound O(n^2) on large productions

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shingles(norm: string, k = SHINGLE_K): Set<string> {
  const words = norm.split(" ").filter(Boolean);
  const set = new Set<string>();
  if (words.length < k) {
    if (words.length) set.add(words.join(" "));
    return set;
  }
  for (let i = 0; i + k <= words.length; i++) set.add(words.slice(i, i + k).join(" "));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function previewOf(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 160);
}

interface Block {
  filename: string;
  page: number | null;
  raw: string;
  norm: string;
  sh: Set<string>;
}

export function findDuplicateBlocks(files: FilePages[]): DuplicateResult {
  // Build candidate blocks (skip short pages).
  const blocks: Block[] = [];
  for (const f of files) {
    for (const p of f.pages) {
      const raw = (p.text || "").trim();
      const norm = normalize(raw);
      if (norm.length < MIN_BLOCK_CHARS) continue;
      blocks.push({ filename: f.filename, page: p.pageNum, raw, norm, sh: shingles(norm) });
    }
  }

  const matches: DuplicateMatch[] = [];
  const usedExact = new Set<number>(); // block indices already claimed by an exact group

  // 1) EXACT duplicates — group by normalized text (O(n)).
  const byNorm = new Map<string, number[]>();
  blocks.forEach((b, i) => {
    const arr = byNorm.get(b.norm);
    if (arr) arr.push(i);
    else byNorm.set(b.norm, [i]);
  });
  for (const idxs of byNorm.values()) {
    if (idxs.length < 2) continue;
    idxs.forEach((i) => usedExact.add(i));
    const blks = idxs.map((i) => ({
      filename: blocks[i]!.filename,
      page: blocks[i]!.page,
      preview: previewOf(blocks[i]!.raw),
    }));
    const files = new Set(blks.map((b) => b.filename));
    matches.push({
      type: "EXACT",
      similarity: 1,
      scope: files.size > 1 ? "cross-file" : "within-file",
      blocks: blks,
    });
  }

  // 2) NEAR duplicates — shingle Jaccard, bounded by length buckets + a hard cap.
  let note: string | undefined;
  const candidates = blocks.map((_, i) => i).filter((i) => !usedExact.has(i));
  // sort by length so similar-length blocks are adjacent (cheap banding)
  candidates.sort((a, b) => blocks[a]!.norm.length - blocks[b]!.norm.length);
  let comparisons = 0;
  const pairedNear = new Set<string>();
  outer: for (let a = 0; a < candidates.length; a++) {
    const ia = candidates[a]!;
    const lenA = blocks[ia]!.norm.length;
    for (let b = a + 1; b < candidates.length; b++) {
      const ib = candidates[b]!;
      const lenB = blocks[ib]!.norm.length;
      if (lenB > lenA * 1.6) break; // lengths too different; later ones only longer
      if (++comparisons > MAX_NEAR_COMPARISONS) {
        note = "Near-duplicate scan was bounded for performance; exact duplicates are complete.";
        break outer;
      }
      const sim = jaccard(blocks[ia]!.sh, blocks[ib]!.sh);
      if (sim >= NEAR_THRESHOLD) {
        const key = ia < ib ? ia + ":" + ib : ib + ":" + ia;
        if (pairedNear.has(key)) continue;
        pairedNear.add(key);
        const blks = [ia, ib].map((i) => ({
          filename: blocks[i]!.filename,
          page: blocks[i]!.page,
          preview: previewOf(blocks[i]!.raw),
        }));
        matches.push({
          type: "NEAR",
          similarity: Math.round(sim * 100) / 100,
          scope: blocks[ia]!.filename === blocks[ib]!.filename ? "within-file" : "cross-file",
          blocks: blks,
        });
      }
    }
  }

  // Sort: exact first, then by similarity desc.
  matches.sort((m, n) =>
    m.type === n.type ? n.similarity - m.similarity : m.type === "EXACT" ? -1 : 1,
  );

  return { matches, blocksScanned: blocks.length, note };
}
