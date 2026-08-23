/**
 * Product Identity Batch 3 — structural attribute compatibility gates.
 * Hard conflicts must reject merge; prefer unresolved over false merge.
 */

import type { ProductAttributes } from './productIdentityContract';
import { getAttributeValue } from './universalProductSpecParser';

export type StructuralConflictKind =
  | 'volume'
  | 'mass'
  | 'pack_count'
  | 'count'
  | 'length'
  | 'roll_count'
  | 'pack_structure'
  | 'variant_token';

export type StructuralConflict = {
  kind: StructuralConflictKind;
  left: string;
  right: string;
};

const REL_TOL = 0.02; // 2% relative tolerance for continuous measures
const ABS_ML = 1;
const ABS_G = 1;
const ABS_MM = 1;

function num(attrs: ProductAttributes, dim: string): number | null {
  const v = getAttributeValue(attrs, dim);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function nearlyEqual(a: number, b: number, absTol: number): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  if (diff <= absTol) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff / scale <= REL_TOL;
}

/**
 * Compare unit volumes (not derived totals) when both sides have volume.
 * Multipack: volume=500 + pack_count=6 must not equal bare volume=3000.
 */
export function findStructuralConflicts(
  left: ProductAttributes,
  right: ProductAttributes
): StructuralConflict[] {
  const conflicts: StructuralConflict[] = [];

  const lv = num(left, 'volume');
  const rv = num(right, 'volume');
  if (lv != null && rv != null && !nearlyEqual(lv, rv, ABS_ML)) {
    conflicts.push({
      kind: 'volume',
      left: `${lv}ml`,
      right: `${rv}ml`,
    });
  }

  const lm = num(left, 'mass');
  const rm = num(right, 'mass');
  if (lm != null && rm != null && !nearlyEqual(lm, rm, ABS_G)) {
    conflicts.push({
      kind: 'mass',
      left: `${lm}g`,
      right: `${rm}g`,
    });
  }

  const lp = num(left, 'pack_count');
  const rp = num(right, 'pack_count');
  const leftPack = lp != null && lp > 1 ? lp : 1;
  const rightPack = rp != null && rp > 1 ? rp : 1;
  if (lp != null && rp != null && leftPack !== rightPack) {
    conflicts.push({
      kind: 'pack_count',
      left: String(leftPack),
      right: String(rightPack),
    });
  }

  // pack structure: one side multipack, other side only total-equivalent volume
  const lt = num(left, 'total_volume');
  const rt = num(right, 'total_volume');
  if (lv != null && rv != null) {
    const leftMulti = leftPack > 1;
    const rightMulti = rightPack > 1;
    if (leftMulti !== rightMulti) {
      // e.g. 500ml×6 vs 3000ml
      conflicts.push({
        kind: 'pack_structure',
        left: leftMulti ? `${lv}ml×${leftPack}` : `${lv}ml`,
        right: rightMulti ? `${rv}ml×${rightPack}` : `${rv}ml`,
      });
    }
  } else if (lv != null && rt != null && leftPack > 1) {
    // left multipack, right only total_volume attribute
    if (nearlyEqual(lv * leftPack, rt, ABS_ML) || nearlyEqual(lv, rt, ABS_ML)) {
      conflicts.push({
        kind: 'pack_structure',
        left: `${lv}ml×${leftPack}`,
        right: `total ${rt}ml`,
      });
    }
  } else if (rv != null && lt != null && rightPack > 1) {
    if (nearlyEqual(rv * rightPack, lt, ABS_ML) || nearlyEqual(rv, lt, ABS_ML)) {
      conflicts.push({
        kind: 'pack_structure',
        left: `total ${lt}ml`,
        right: `${rv}ml×${rightPack}`,
      });
    }
  }

  const lc = num(left, 'count');
  const rc = num(right, 'count');
  if (lc != null && rc != null && lc !== rc) {
    conflicts.push({
      kind: 'count',
      left: String(lc),
      right: String(rc),
    });
  }

  const ll = num(left, 'length');
  const rl = num(right, 'length');
  if (ll != null && rl != null && !nearlyEqual(ll, rl, ABS_MM)) {
    conflicts.push({
      kind: 'length',
      left: `${ll}mm`,
      right: `${rl}mm`,
    });
  }

  const lr = num(left, 'roll_count');
  const rr = num(right, 'roll_count');
  if (lr != null && rr != null && lr !== rr) {
    conflicts.push({
      kind: 'roll_count',
      left: String(lr),
      right: String(rr),
    });
  }

  return conflicts;
}

export function hasStructuralConflict(
  left: ProductAttributes,
  right: ProductAttributes
): boolean {
  return findStructuralConflicts(left, right).length > 0;
}

/**
 * Variant tokens that must not be silently merged when only one side has them.
 * Conservative: any exclusive distinguishing token → conflict.
 */
const VARIANT_TOKEN_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'zero', re: /(?:zero|ゼロ|零)/i },
  { id: 'sugar_free', re: /(?:無糖|シュガーフリー|sugar\s*free)/i },
  { id: 'low_fat', re: /(?:低脂肪|低脂肪乳)/i },
  { id: 'lemon', re: /(?:レモン|lemon)/i },
  { id: 'milk_tea', re: /(?:ミルクティー|milk\s*tea)/i },
  { id: 'straight', re: /(?:ストレート|straight)/i },
  { id: 'caffeine_free', re: /(?:カフェインレス|デカフェ|decaf)/i },
  { id: 'organic', re: /(?:有機|オーガニック|organic)/i },
];

export function findVariantTokenConflicts(
  leftText: string,
  rightText: string
): StructuralConflict[] {
  const conflicts: StructuralConflict[] = [];
  for (const { id, re } of VARIANT_TOKEN_PATTERNS) {
    const l = re.test(leftText);
    const r = re.test(rightText);
    if (l !== r) {
      conflicts.push({
        kind: 'variant_token',
        left: l ? id : `¬${id}`,
        right: r ? id : `¬${id}`,
      });
    }
  }
  return conflicts;
}

export function attributesAreCompatible(
  left: ProductAttributes,
  right: ProductAttributes,
  leftText?: string,
  rightText?: string
): { ok: boolean; conflicts: StructuralConflict[] } {
  const conflicts = findStructuralConflicts(left, right);
  if (leftText != null && rightText != null) {
    conflicts.push(...findVariantTokenConflicts(leftText, rightText));
  }
  return { ok: conflicts.length === 0, conflicts };
}
