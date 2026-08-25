/**
 * A1 — Basket consolidation within a canonical receipt (read-only).
 *
 * Priority: merchant_product / canonical identity > normalized identity > no merge.
 */

import type { ReceiptRow } from '../db';
import { itemAmountForAnalytics, type DiscountableItem } from '../receiptDiscountAllocation';
import { normalizeProductForIdentity } from '../normalizeProductForIdentity';
import { attributesAreCompatible } from '../productIdentityStructuralConflict';
import { getReceiptItems } from '../receiptItems';
import type {
  BasketMergeConfidence,
  ConsolidatedBasket,
  ConsolidatedBasketLine,
} from './types';

type ParsedLine = {
  index: number;
  rawName: string;
  quantity: number;
  lineTotal: number;
  unitPrice: number | null;
  merchantProductId: string | null;
  canonicalProductId: string | null;
  comparisonKey: string;
  attributes: ReturnType<typeof normalizeProductForIdentity>['attributes'];
  identityConfidence: number;
  identitySource: string;
  isNonProduct: boolean;
};

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function readName(item: Record<string, unknown>): string {
  for (const key of [
    'name',
    'raw_name',
    'normalized_full_name',
    'canonical_product_name',
  ]) {
    const v = item[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function readQuantity(item: Record<string, unknown>): number {
  const q = item.quantity;
  if (typeof q === 'number' && Number.isFinite(q) && q > 0) return q;
  return 1;
}

function isNonProductRow(item: Record<string, unknown>): boolean {
  const cat = typeof item.category === 'string' ? item.category : '';
  if (/^(discount|coupon|fee|tax|subtotal|total|payment)/i.test(cat)) return true;
  const name = readName(item);
  if (!name) return true;
  return false;
}

function parseReceiptLine(index: number, raw: unknown): ParsedLine {
  const item =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawName = readName(item);
  const quantity = readQuantity(item);
  const lineTotal = itemAmountForAnalytics(item as DiscountableItem);
  const unitPrice =
    quantity > 0 && Number.isFinite(lineTotal)
      ? roundMoney(lineTotal / quantity)
      : null;
  const normalized = normalizeProductForIdentity(rawName);
  const identityConfidence =
    typeof item.identity_confidence === 'number' &&
    Number.isFinite(item.identity_confidence)
      ? item.identity_confidence
      : 0;
  const identitySource =
    typeof item.identity_source === 'string' ? item.identity_source : 'unknown';

  return {
    index,
    rawName,
    quantity,
    lineTotal,
    unitPrice,
    merchantProductId:
      typeof item.merchant_product_id === 'string' && item.merchant_product_id
        ? item.merchant_product_id
        : null,
    canonicalProductId:
      typeof item.canonical_product_id === 'string' && item.canonical_product_id
        ? item.canonical_product_id
        : null,
    comparisonKey: normalized.comparisonKey,
    attributes: normalized.attributes,
    identityConfidence,
    identitySource,
    isNonProduct: isNonProductRow(item),
  };
}

function moneyClose(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) <= tol;
}

type MergeDecision = {
  canMerge: boolean;
  confidence: BasketMergeConfidence;
  bucketKey: string | null;
  evidence: string[];
};

function decideMerge(a: ParsedLine, b: ParsedLine): MergeDecision {
  if (a.isNonProduct || b.isNonProduct) {
    return {
      canMerge: false,
      confidence: 'none',
      bucketKey: null,
      evidence: ['non_product_row'],
    };
  }

  if (a.merchantProductId && b.merchantProductId) {
    if (a.merchantProductId === b.merchantProductId) {
      const compat = attributesAreCompatible(
        a.attributes,
        b.attributes,
        a.rawName,
        b.rawName
      );
      if (!compat.ok) {
        return {
          canMerge: false,
          confidence: 'none',
          bucketKey: null,
          evidence: [
            'merchant_product_id_match_but_spec_conflict',
            ...compat.conflicts.map((c) => `${c.kind}:${c.left}≠${c.right}`),
          ],
        };
      }
      return {
        canMerge: true,
        confidence: 'high',
        bucketKey: `mp:${a.merchantProductId}`,
        evidence: ['same_merchant_product_id', 'attributes_compatible'],
      };
    }
    return {
      canMerge: false,
      confidence: 'none',
      bucketKey: null,
      evidence: ['different_merchant_product_id'],
    };
  }

  if (a.canonicalProductId && b.canonicalProductId) {
    if (a.canonicalProductId !== b.canonicalProductId) {
      return {
        canMerge: false,
        confidence: 'none',
        bucketKey: null,
        evidence: ['different_canonical_product_id'],
      };
    }
    const compat = attributesAreCompatible(
      a.attributes,
      b.attributes,
      a.rawName,
      b.rawName
    );
    if (!compat.ok) {
      return {
        canMerge: false,
        confidence: 'none',
        bucketKey: null,
        evidence: [
          'canonical_product_spec_conflict',
          ...compat.conflicts.map((c) => `${c.kind}:${c.left}≠${c.right}`),
        ],
      };
    }
    return {
      canMerge: true,
      confidence: 'high',
      bucketKey: `cp:${a.canonicalProductId}`,
      evidence: ['same_canonical_product_id', 'attributes_compatible'],
    };
  }

  const compat = attributesAreCompatible(
    a.attributes,
    b.attributes,
    a.rawName,
    b.rawName
  );
  if (!compat.ok) {
    return {
      canMerge: false,
      confidence: 'none',
      bucketKey: null,
      evidence: [
        'normalized_spec_conflict',
        ...compat.conflicts.map((c) => `${c.kind}:${c.left}≠${c.right}`),
      ],
    };
  }

  const minConf = Math.min(a.identityConfidence, b.identityConfidence);
  if (
    a.comparisonKey &&
    a.comparisonKey === b.comparisonKey &&
    minConf >= 0.55
  ) {
    if (
      a.unitPrice != null &&
      b.unitPrice != null &&
      moneyClose(a.unitPrice, b.unitPrice)
    ) {
      return {
        canMerge: true,
        confidence: minConf >= 0.75 ? 'medium' : 'low',
        bucketKey: `nk:${a.comparisonKey}|up:${a.unitPrice.toFixed(2)}`,
        evidence: [
          'same_comparison_key',
          'matching_unit_price',
          `identity_confidence_min=${minConf.toFixed(2)}`,
        ],
      };
    }
    return {
      canMerge: false,
      confidence: 'none',
      bucketKey: null,
      evidence: ['same_comparison_key_but_unit_price_mismatch'],
    };
  }

  if (
    a.comparisonKey &&
    a.comparisonKey === b.comparisonKey &&
    a.unitPrice != null &&
    b.unitPrice != null &&
    moneyClose(a.unitPrice, b.unitPrice) &&
    minConf < 0.55
  ) {
    return {
      canMerge: false,
      confidence: 'none',
      bucketKey: null,
      evidence: ['comparison_key_and_price_match_but_identity_low_confidence'],
    };
  }

  return {
    canMerge: false,
    confidence: 'none',
    bucketKey: null,
    evidence: ['insufficient_identity_for_merge'],
  };
}

function pickDisplayName(lines: ParsedLine[]): string {
  const sorted = [...lines].sort((a, b) => b.identityConfidence - a.identityConfidence);
  return sorted[0]?.rawName ?? lines[0]?.rawName ?? '';
}

function mergeLines(lines: ParsedLine[]): ConsolidatedBasketLine {
  const quantity = lines.reduce((s, l) => s + l.quantity, 0);
  const lineTotal = roundMoney(lines.reduce((s, l) => s + l.lineTotal, 0));
  const unitPrice =
    quantity > 0 ? roundMoney(lineTotal / quantity) : lines[0]?.unitPrice ?? null;

  let mergeConfidence: BasketMergeConfidence = 'none';
  const mergeEvidence = new Set<string>();
  let identityBucketKey: string | null = null;

  if (lines.length === 1) {
    mergeConfidence = 'none';
    mergeEvidence.add('single_source_line');
  } else {
    for (let i = 1; i < lines.length; i++) {
      const d = decideMerge(lines[0]!, lines[i]!);
      if (d.confidence !== 'none') {
        mergeConfidence = d.confidence;
      }
      if (d.bucketKey) identityBucketKey = d.bucketKey;
      for (const e of d.evidence) mergeEvidence.add(e);
    }
    mergeEvidence.add(`merged_line_count=${lines.length}`);
  }

  return {
    quantity,
    unitPrice,
    lineTotal,
    displayName: pickDisplayName(lines),
    mergeConfidence,
    mergeEvidence: [...mergeEvidence],
    sourceItemIndexes: lines.map((l) => l.index).sort((a, b) => a - b),
    identityBucketKey,
  };
}

/**
 * Consolidate duplicate product lines within one receipt.
 * Conservative: when identity is uncertain, lines stay separate.
 */
export function consolidateReceiptBasket(receipt: ReceiptRow): ConsolidatedBasket {
  const rawItems = getReceiptItems(receipt);
  const parsed = rawItems.map((raw, index) => parseReceiptLine(index, raw));

  const buckets = new Map<string, ParsedLine[]>();
  const unbucketed: ParsedLine[] = [];

  for (const line of parsed) {
    if (line.isNonProduct) {
      unbucketed.push(line);
      continue;
    }

    let placed = false;
    for (const [, bucket] of buckets) {
      const decision = decideMerge(bucket[0]!, line);
      if (decision.canMerge && decision.bucketKey) {
        bucket.push(line);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const selfKey = `solo:${line.index}`;
      buckets.set(selfKey, [line]);
    }
  }

  const consolidated: ConsolidatedBasketLine[] = [
    ...[...buckets.values()].map(mergeLines),
    ...unbucketed.map((line) => mergeLines([line])),
  ];

  consolidated.sort((a, b) => a.sourceItemIndexes[0]! - b.sourceItemIndexes[0]!);

  return {
    receiptId: receipt.id,
    lines: consolidated,
    unmergedLineCount: consolidated.filter((l) => l.sourceItemIndexes.length === 1)
      .length,
  };
}
