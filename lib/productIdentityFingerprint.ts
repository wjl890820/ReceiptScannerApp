/**
 * Stable fingerprint for a receipt line identity link.
 * When fingerprint changes, prior derived links are stale and must recompute.
 */

import type { ProductAttributes } from './productIdentityContract';

export type IdentityFingerprintInput = {
  rawName: string;
  normalizedName: string;
  comparisonKey: string;
  attributes: ProductAttributes;
  quantity?: number | null;
  lineTotal?: number | null;
};

function stableAttrs(attrs: ProductAttributes): string {
  const entries = [...attrs.entries]
    .map((e) => `${e.dimension}:${String(e.value)}:${e.unit ?? ''}`)
    .sort();
  return entries.join('|');
}

/** FNV-1a 32-bit — deterministic, no crypto dependency. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function buildItemIdentityFingerprint(input: IdentityFingerprintInput): string {
  const qty =
    input.quantity != null && Number.isFinite(input.quantity)
      ? String(input.quantity)
      : '';
  const total =
    input.lineTotal != null && Number.isFinite(input.lineTotal)
      ? String(input.lineTotal)
      : '';
  const payload = [
    input.rawName.trim(),
    input.normalizedName.trim(),
    input.comparisonKey.trim(),
    stableAttrs(input.attributes),
    qty,
    total,
  ].join('\u001f');
  return `ifp_${fnv1a(payload)}_${fnv1a(payload.split('').reverse().join(''))}`;
}
