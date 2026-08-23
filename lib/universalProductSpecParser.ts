/**
 * Universal structural product-spec parser (Product Identity Batch 2).
 *
 * Goal: extract measurement / pack structure from ANY product name into
 * Batch-1 `ProductAttributes` — without knowing the product family.
 *
 * Future structural SSOT = ProductAttributes.
 * Live Analysis continues to use `parseProductSpecification` (unchanged).
 *
 * Pure / deterministic / offline. Zero Gemini calls.
 */

import {
  buildProductAttributes,
  emptyProductAttributes,
  type ProductAttributeEntry,
  type ProductAttributes,
} from './productIdentityContract';
import { prepareProductTextForParsing } from './universalProductNormalizer';

export const UNIVERSAL_PRODUCT_SPEC_PARSER_VERSION =
  'meruno-universal-product-spec-parser-v1' as const;

export type StructuralParseEvidence = {
  rule: string;
  matchedText: string;
};

export type StructuralParseResult = {
  attributes: ProductAttributes;
  evidence: StructuralParseEvidence[];
  parserVersion: typeof UNIVERSAL_PRODUCT_SPEC_PARSER_VERSION;
};

const MAX_VOLUME_ML = 50_000;
const MAX_MASS_G = 200_000;
const MAX_LENGTH_MM = 500_000;
const MAX_COUNT = 10_000;

/** Count unit labels (family-agnostic). */
const COUNT_UNIT =
  '個|本|枚|袋|箱|缶|瓶|包|粒|錠|食|束|パック|pack|pcs?|pk';

/** Guard: bare model / version / percent / year patterns — never attributes. */
function isBlockedNumericContext(text: string, matchIndex: number, matchLength: number): boolean {
  const before = text.slice(Math.max(0, matchIndex - 8), matchIndex);
  const after = text.slice(matchIndex + matchLength, matchIndex + matchLength + 8);
  const window = `${before}${text.slice(matchIndex, matchIndex + matchLength)}${after}`;

  // USB 3.0 / HDMI 2.1 / Wi-Fi 6
  if (/(?:usb|hdmi|wifi|wi-fi|bluetooth|http|ver\.?)\s*\d/i.test(window)) return true;
  // iPhone 16 / Pixel 8 / Galaxy S24 style — digit after Latin product token
  if (/[a-z]{2,}\s+\d{1,3}(?:\.\d+)?\b/i.test(window) && !/\d+\s*(?:ml|l|g|kg|m|cm|mm)/i.test(window)) {
    // only block when the match itself is a bare number without unit
  }
  // 30%OFF / 30％引き
  if (/\d+\s*[%％]/.test(window)) return true;
  // No.5 / Ｎｏ．５
  if (/(?:no|nо)\s*\.?\s*\d+/i.test(window)) return true;
  // Years 19xx/20xx standing alone near match
  if (/\b(?:19|20)\d{2}\b/.test(window) && !/\d+\s*(?:ml|l|g|kg)/i.test(window)) {
    const matched = text.slice(matchIndex, matchIndex + matchLength);
    if (/^(?:19|20)\d{2}$/.test(matched.trim())) return true;
  }
  // 2+1 / 1+1 促销
  if (/\d\s*[+＋]\s*\d/.test(window)) return true;

  // Fastener / bolt style M6×20 — block only spans that are part of the
  // fastener itself, not a nearby valid count like "8本".
  const matched = text.slice(matchIndex, matchIndex + matchLength);
  if (/^[mMｍ]?[mM]?\d+(?:\.\d+)?\s*×\s*\d+(?:\.\d+)?$/.test(matched.trim())) {
    return true;
  }
  if (
    /^\d+(?:\.\d+)?$/.test(matched.trim()) &&
    /[mMｍ]\d+(?:\.\d+)?\s*×\s*$/.test(before)
  ) {
    return true;
  }
  if (
    /^[mMｍ]\d+(?:\.\d+)?$/.test(matched.trim()) &&
    /^\s*×\s*\d+/.test(after)
  ) {
    return true;
  }

  return false;
}

function pushEntry(
  entries: ProductAttributeEntry[],
  evidence: StructuralParseEvidence[],
  entry: ProductAttributeEntry,
  rule: string,
  matchedText: string
): void {
  entries.push(entry);
  evidence.push({ rule, matchedText });
}

function toNumber(raw: string): number {
  return Number(raw);
}

/**
 * Parse structural measurement attributes from a product name.
 * Partial understanding is success — empty attributes are valid.
 */
export function parseStructuralProductAttributes(
  rawName: string
): StructuralParseResult {
  const text = prepareProductTextForParsing(rawName);
  if (!text) {
    return {
      attributes: emptyProductAttributes(),
      evidence: [],
      parserVersion: UNIVERSAL_PRODUCT_SPEC_PARSER_VERSION,
    };
  }

  const entries: ProductAttributeEntry[] = [];
  const evidence: StructuralParseEvidence[] = [];
  const consumed: Array<{ start: number; end: number }> = [];

  const overlaps = (start: number, end: number): boolean =>
    consumed.some((c) => start < c.end && end > c.start);

  const claim = (start: number, end: number): boolean => {
    if (overlaps(start, end)) return false;
    if (isBlockedNumericContext(text, start, end - start)) return false;
    consumed.push({ start, end });
    return true;
  };

  // --- Multipack: content × pack  (500ml×6 / 500ml×6本 / 200g×3袋) ---
  {
    const re = new RegExp(
      `(\\d+(?:\\.\\d+)?)\\s*(ml|l|g|kg)\\s*×\\s*(\\d{1,4})\\s*(?:${COUNT_UNIT})?`,
      'gi'
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!claim(start, end)) continue;
      const size = toNumber(m[1]);
      const unit = m[2].toLowerCase();
      const pack = toNumber(m[3]);
      if (!Number.isFinite(size) || size <= 0 || !Number.isInteger(pack) || pack < 1) continue;

      if (unit === 'ml' || unit === 'l') {
        const ml = unit === 'l' ? size * 1000 : size;
        if (ml > MAX_VOLUME_ML) continue;
        pushEntry(
          entries,
          evidence,
          { dimension: 'volume', value: ml, unit: 'ml', confidence: 0.99, source: m[0] },
          'volume_multipack',
          m[0]
        );
        if (pack > 1) {
          pushEntry(
            entries,
            evidence,
            { dimension: 'pack_count', value: pack, unit: 'count', confidence: 0.99, source: m[0] },
            'volume_multipack_pack',
            m[0]
          );
          pushEntry(
            entries,
            evidence,
            {
              dimension: 'total_volume',
              value: ml * pack,
              unit: 'ml',
              confidence: 0.95,
              source: m[0],
            },
            'volume_multipack_total',
            m[0]
          );
        }
      } else {
        const g = unit === 'kg' ? size * 1000 : size;
        if (g > MAX_MASS_G) continue;
        pushEntry(
          entries,
          evidence,
          { dimension: 'mass', value: g, unit: 'g', confidence: 0.99, source: m[0] },
          'mass_multipack',
          m[0]
        );
        if (pack > 1) {
          pushEntry(
            entries,
            evidence,
            { dimension: 'pack_count', value: pack, unit: 'count', confidence: 0.99, source: m[0] },
            'mass_multipack_pack',
            m[0]
          );
          pushEntry(
            entries,
            evidence,
            {
              dimension: 'total_mass',
              value: g * pack,
              unit: 'g',
              confidence: 0.95,
              source: m[0],
            },
            'mass_multipack_total',
            m[0]
          );
        }
      }
    }
  }

  // --- Multipack: pack × content  (6×500ml) — require unit on content side ---
  {
    const re = /(\d{1,4})\s*×\s*(\d+(?:\.\d+)?)\s*(ml|l|g|kg)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      const start = m.index;
      const end = start + m[0].length;
      // Reject fastener contexts already handled by isBlockedNumericContext (M6×20)
      if (!claim(start, end)) continue;
      const pack = toNumber(m[1]);
      const size = toNumber(m[2]);
      const unit = m[3].toLowerCase();
      if (!Number.isInteger(pack) || pack < 1 || !Number.isFinite(size) || size <= 0) continue;

      if (unit === 'ml' || unit === 'l') {
        const ml = unit === 'l' ? size * 1000 : size;
        if (ml > MAX_VOLUME_ML) continue;
        pushEntry(
          entries,
          evidence,
          { dimension: 'volume', value: ml, unit: 'ml', confidence: 0.99, source: m[0] },
          'pack_times_volume',
          m[0]
        );
        if (pack > 1) {
          pushEntry(
            entries,
            evidence,
            { dimension: 'pack_count', value: pack, unit: 'count', confidence: 0.99, source: m[0] },
            'pack_times_volume_pack',
            m[0]
          );
        }
      } else {
        const g = unit === 'kg' ? size * 1000 : size;
        if (g > MAX_MASS_G) continue;
        pushEntry(
          entries,
          evidence,
          { dimension: 'mass', value: g, unit: 'g', confidence: 0.99, source: m[0] },
          'pack_times_mass',
          m[0]
        );
        if (pack > 1) {
          pushEntry(
            entries,
            evidence,
            { dimension: 'pack_count', value: pack, unit: 'count', confidence: 0.99, source: m[0] },
            'pack_times_mass_pack',
            m[0]
          );
        }
      }
    }
  }

  // --- Roll count: 12ロール ---
  {
    const re = /(\d{1,4})\s*(?:ロール|roll)s?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!claim(start, end)) continue;
      const n = toNumber(m[1]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) continue;
      pushEntry(
        entries,
        evidence,
        { dimension: 'roll_count', value: n, unit: 'roll', confidence: 0.99, source: m[0] },
        'roll_count',
        m[0]
      );
    }
  }

  // --- Length: 2m / 50cm / 30メートル / 100mm ---
  {
    const re = /(\d+(?:\.\d+)?)\s*(mm|cm|m|メートル|ﾒｰﾄﾙ)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      const start = m.index;
      const end = start + m[0].length;
      // Avoid matching the `m` in `ml` — word boundary after unit helps; also skip if followed by l
      const unitRaw = m[2].toLowerCase();
      if (unitRaw === 'm' && /l/i.test(text.slice(end, end + 1))) continue;
      if (!claim(start, end)) continue;
      const size = toNumber(m[1]);
      if (!Number.isFinite(size) || size <= 0) continue;
      let mm: number;
      if (unitRaw === 'mm') mm = size;
      else if (unitRaw === 'cm') mm = size * 10;
      else mm = size * 1000; // m / メートル
      if (mm > MAX_LENGTH_MM) continue;
      pushEntry(
        entries,
        evidence,
        { dimension: 'length', value: mm, unit: 'mm', confidence: 0.99, source: m[0] },
        'length',
        m[0]
      );
    }
  }

  // --- Simple volume / mass (after multipacks claimed) ---
  {
    const re = /(\d+(?:\.\d+)?)\s*(ml|l|g|kg)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!claim(start, end)) continue;
      const size = toNumber(m[1]);
      const unit = m[2].toLowerCase();
      if (!Number.isFinite(size) || size <= 0) continue;
      if (unit === 'ml' || unit === 'l') {
        const ml = unit === 'l' ? size * 1000 : size;
        if (ml > MAX_VOLUME_ML) continue;
        pushEntry(
          entries,
          evidence,
          { dimension: 'volume', value: ml, unit: 'ml', confidence: 0.99, source: m[0] },
          'volume',
          m[0]
        );
      } else {
        const g = unit === 'kg' ? size * 1000 : size;
        if (g > MAX_MASS_G) continue;
        pushEntry(
          entries,
          evidence,
          { dimension: 'mass', value: g, unit: 'g', confidence: 0.99, source: m[0] },
          'mass',
          m[0]
        );
      }
    }
  }

  // --- Count with explicit unit label (8本 / 10個 / 30枚 / 3食入 / 12個入) ---
  {
    const re = new RegExp(`(\\d{1,4})\\s*(${COUNT_UNIT})\\s*(?:入)?`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!claim(start, end)) continue;
      const n = toNumber(m[1]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) continue;
      const unitLabel = m[2];
      pushEntry(
        entries,
        evidence,
        {
          dimension: 'count',
          value: n,
          unit: unitLabel.toLowerCase(),
          confidence: 0.95,
          source: m[0],
        },
        'count',
        m[0]
      );
    }
  }

  // --- N入 without other unit (6入) as pack_count only when not blocked ---
  {
    const re = /(\d{1,4})\s*入(?![ぁ-んァ-ヶ一-龥a-z])/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!claim(start, end)) continue;
      const n = toNumber(m[1]);
      if (!Number.isInteger(n) || n < 2 || n > MAX_COUNT) continue;
      pushEntry(
        entries,
        evidence,
        { dimension: 'pack_count', value: n, unit: 'count', confidence: 0.7, source: m[0] },
        'iri_pack',
        m[0]
      );
    }
  }

  return {
    attributes: buildProductAttributes(entries),
    evidence,
    parserVersion: UNIVERSAL_PRODUCT_SPEC_PARSER_VERSION,
  };
}

export function getAttributeValue(
  attrs: ProductAttributes,
  dimension: string
): number | string | null {
  const hit = attrs.entries.find((e) => e.dimension === dimension);
  return hit ? hit.value : null;
}
