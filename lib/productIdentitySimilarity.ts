/**
 * Conservative string similarity helpers for Product Identity Batch 3.
 * Fuzzy scores generate candidates; they are not the default judge.
 */

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = new Array<number>(cols);
  const cur = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i < rows; i += 1) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j < cols; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < cols; j += 1) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/** 1 = identical, 0 = totally different. */
export function levenshteinSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

export function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/i)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  );
}

export function jaccardSimilarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Combined score used only for same-merchant candidate ranking.
 * Auto-match requires HIGH threshold (see resolver constants).
 */
export function combinedNameSimilarity(a: string, b: string): number {
  const lev = levenshteinSimilarity(a, b);
  const jac = jaccardSimilarity(a, b);
  return 0.65 * lev + 0.35 * jac;
}

export type FuzzySimilarityDiagnostics = {
  candidateVisits: number;
  upperBoundRejected: number;
  lengthUpperBoundRejected: number;
  tokenUpperBoundRejected: number;
  expensiveSimilarityCalls: number;
};

function levenshteinSimilarityLengthUpperBound(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  return maxLength === 0
    ? 1
    : 1 - Math.abs(a.length - b.length) / maxLength;
}

/**
 * Exact upper bound for the current combined score before Levenshtein work.
 * distance(a,b) >= |length(a)-length(b)|, therefore Levenshtein similarity
 * cannot exceed 1 - lengthDifference / maxLength. Jaccard is computed exactly.
 */
export function combinedNameSimilarityUpperBound(
  a: string,
  b: string
): number {
  const levenshteinUpperBound = levenshteinSimilarityLengthUpperBound(a, b);
  return 0.65 * levenshteinUpperBound + 0.35 * jaccardSimilarity(a, b);
}

/**
 * Returns null only when the unchanged combined score is provably below the
 * supplied floor. Survivors use combinedNameSimilarity without modification.
 */
export function combinedNameSimilarityAtOrAbovePotential(
  a: string,
  b: string,
  floor: number,
  diagnostics?: FuzzySimilarityDiagnostics
): number | null {
  if (diagnostics) diagnostics.candidateVisits += 1;
  const levenshteinUpperBound = levenshteinSimilarityLengthUpperBound(a, b);
  if (0.65 * levenshteinUpperBound + 0.35 < floor) {
    if (diagnostics) {
      diagnostics.upperBoundRejected += 1;
      diagnostics.lengthUpperBoundRejected += 1;
    }
    return null;
  }
  if (combinedNameSimilarityUpperBound(a, b) < floor) {
    if (diagnostics) {
      diagnostics.upperBoundRejected += 1;
      diagnostics.tokenUpperBoundRejected += 1;
    }
    return null;
  }
  if (diagnostics) diagnostics.expensiveSimilarityCalls += 1;
  return combinedNameSimilarity(a, b);
}
