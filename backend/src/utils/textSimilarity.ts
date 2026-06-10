// Fuzzy text-similarity helpers used to de-duplicate timeline events, key dates,
// conflicts, and notes when merging saved timeline records (finding ARCH-006 —
// extracted from the inline implementation in routes/records.ts so it can be
// reused and unit-tested).

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "and",
  "or",
  "was",
  "were",
  "is",
  "by",
  "with",
  "from",
  "that",
  "this",
  "it",
  "be",
  "as",
  "had",
  "has",
  "have",
]);

/** Lowercase, strip punctuation, and collapse whitespace. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Significant words (normalized, length > 2, stop-words removed). */
export function keyWords(s: string): Set<string> {
  return new Set(
    normalize(s)
      .split(" ")
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

/** Overlap of key words: intersection / size of the smaller set (0–1). */
export function wordOverlap(a: string, b: string): number {
  const wa = keyWords(a);
  const wb = keyWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let intersection = 0;
  for (const w of wa) {
    if (wb.has(w)) intersection++;
  }
  return intersection / Math.min(wa.size, wb.size);
}

/** Heuristic "same event/text" check: exact-normalized, prefix-containment, or ≥60% word overlap. */
export function isSimilar(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  // Check if one contains most of the other.
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  if (
    shorter.length > 15 &&
    longer.includes(shorter.substring(0, Math.floor(shorter.length * 0.7)))
  )
    return true;
  // Word overlap — if 60%+ of key words match, treat as the same event.
  if (wordOverlap(a, b) >= 0.6) return true;
  return false;
}
