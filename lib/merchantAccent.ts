/**
 * Build 53 — Merchant Accent V2.
 * Deterministic hash(normalized merchant) → controlled mature palette.
 * Stronger hue separation than V1; never official brand colors; never status colors.
 */

const MERCHANT_ACCENT_PALETTE_V2 = [
  '#3D6B8C', // steel blue
  '#2A8A8A', // cyan / teal
  '#B07A2E', // amber
  '#6B7A3A', // olive
  '#6B5A8A', // violet
  '#A05A4A', // brick
  '#1F6F6A', // deep teal
  '#4A5578', // slate indigo
] as const;

export type MerchantAccentTone = (typeof MERCHANT_ACCENT_PALETTE_V2)[number];

/** Stable FNV-1a style hash → palette index. */
export function merchantAccentIndex(normalizedMerchantKey: string): number {
  const key = (normalizedMerchantKey || '').trim().toLowerCase();
  if (!key) return 0;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % MERCHANT_ACCENT_PALETTE_V2.length;
}

export function merchantAccentColor(
  normalizedMerchantKey: string | null | undefined
): MerchantAccentTone {
  return MERCHANT_ACCENT_PALETTE_V2[
    merchantAccentIndex(normalizedMerchantKey ?? '')
  ]!;
}

/** Exposed for tests — palette size and uniqueness. */
export function merchantAccentPaletteForTests(): readonly string[] {
  return MERCHANT_ACCENT_PALETTE_V2;
}
