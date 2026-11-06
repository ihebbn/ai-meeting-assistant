/**
 * Pure metric helpers for the ASR benchmark (no Electron imports).
 */

/** Unicode-aware normalisation applied to both reference and hypothesis. */
export function normalizeForScoring(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    // Arabic: drop harakat and tatweel, unify alef variants.
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإ]/g, 'ا')
    // Punctuation and symbols become spaces (apostrophes included, consistently).
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeWords(text: string): string[] {
  const normalized = normalizeForScoring(text);
  return normalized ? normalized.split(' ') : [];
}

export function tokenizeChars(text: string): string[] {
  return Array.from(normalizeForScoring(text).replace(/ /g, ''));
}

/** Levenshtein distance between two token sequences (two-row DP). */
export function editDistance<T>(ref: readonly T[], hyp: readonly T[]): number {
  if (ref.length === 0) {
    return hyp.length;
  }
  if (hyp.length === 0) {
    return ref.length;
  }
  let prev = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  let curr = new Array<number>(hyp.length + 1).fill(0);
  for (let i = 1; i <= ref.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= hyp.length; j += 1) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[hyp.length]!;
}

export type ErrorCount = { errors: number; refLength: number };

export function wordErrors(reference: string, hypothesis: string): ErrorCount {
  const ref = tokenizeWords(reference);
  const hyp = tokenizeWords(hypothesis);
  return { errors: editDistance(ref, hyp), refLength: ref.length };
}

export function charErrors(reference: string, hypothesis: string): ErrorCount {
  const ref = tokenizeChars(reference);
  const hyp = tokenizeChars(hypothesis);
  return { errors: editDistance(ref, hyp), refLength: ref.length };
}

/** Error rate as a fraction; null when there is nothing to score against. */
export function rate(count: ErrorCount): number | null {
  return count.refLength > 0 ? count.errors / count.refLength : null;
}

export function sumErrors(counts: readonly ErrorCount[]): ErrorCount {
  return counts.reduce(
    (acc, c) => ({ errors: acc.errors + c.errors, refLength: acc.refLength + c.refLength }),
    { errors: 0, refLength: 0 },
  );
}

/** Nearest-rank percentile (p in 0..100). Returns null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}
