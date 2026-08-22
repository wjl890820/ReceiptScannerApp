/**
 * R1-B2 — Derived retailer identity (additive, recomputable, non-persistent).
 *
 * Domain SSOT: docs/merchant-domain-contract.md
 *
 * This layer sits ABOVE merchant_normalized and does NOT replace:
 * - merchant_raw / merchant_normalized persistence
 * - merchantAnalyticsKey (V1 analytics aggregation)
 * - merchant_type / V1 eligibility
 * - store_raw / store_normalized (legacy mirrors)
 *
 * No DB / network / AI. Pure functions only.
 */

import {
  canonicalizeMerchantChain,
  normalizeMerchant,
} from './receiptOcrNormalize';

export type DerivedRetailerIdentitySource =
  | 'known_retailer_rule'
  | 'existing_normalized'
  | 'unresolved';

export type DerivedRetailerIdentityConfidence =
  | 'exact'
  | 'derived'
  | 'unknown';

/**
 * Recomputable retailer identity metadata.
 * NOT receipt Source of Truth, NOT merchantAnalyticsKey, NOT a DB retailer id,
 * NOT verified physical-store proof.
 */
export type DerivedRetailerIdentity = {
  retailerKey: string | null;
  retailerDisplayName: string | null;
  /** Parse residue after removing a known chain prefix — NOT a storeKey / store ID. */
  storeHint: string | null;
  source: DerivedRetailerIdentitySource;
  confidence: DerivedRetailerIdentityConfidence;
};

export type DeriveRetailerIdentityInput = {
  merchantRaw?: string | null;
  merchantNormalized?: string | null;
  /** Accepted for future use; not required for V1 recognition. */
  merchantType?: string | null;
};

type RetailerRule = {
  retailerKey: string;
  retailerDisplayName: string;
  /**
   * Compact half-width lower prefixes that MUST appear at the start of the
   * flattened observation (after removing spaces/separators).
   * Longer / more specific prefixes first within each rule.
   */
  matchPrefixes: readonly string[];
};

/**
 * Explicit known-retailer registry (SSOT for R1-B2 recognition).
 * Not a national catalog — only chains evidenced in-repo.
 */
export const RETAILER_IDENTITY_REGISTRY: readonly RetailerRule[] = [
  {
    retailerKey: 'gyomu_super',
    retailerDisplayName: '業務スーパー',
    matchPrefixes: [
      '業務スーパー',
      'ぎょうむスーパー',
      'gyomusuper',
      'gyomu-super',
      'gyomu_super',
    ],
  },
  {
    retailerKey: 'york_benimaru',
    retailerDisplayName: 'ヨークベニマル',
    matchPrefixes: [
      'ヨークベニマル',
      'yorkbenimaru',
      'york-benimaru',
      'york_benimaru',
    ],
  },
  {
    retailerKey: 'costco',
    retailerDisplayName: 'コストコ',
    matchPrefixes: ['コストコ', 'costco', 'costcowholesale', 'コストコホールセール'],
  },
  {
    retailerKey: 'seven_eleven',
    retailerDisplayName: 'セブン-イレブン',
    matchPrefixes: [
      'セブン-イレブン',
      'セブンイレブン',
      '7-eleven',
      '7eleven',
      'seven-eleven',
      'seveneleven',
      // Intentionally NOT bare 'セブン' here — false-positive guard;
      // bare セブン is handled only via existing normalizeMerchant canonical map.
    ],
  },
  {
    retailerKey: 'familymart',
    retailerDisplayName: 'ファミリーマート',
    matchPrefixes: [
      'ファミリーマート',
      'ファミマ',
      'familymart',
      'family-mart',
      'family_mart',
    ],
  },
  {
    retailerKey: 'lawson',
    retailerDisplayName: 'ローソン',
    matchPrefixes: ['ローソン', 'lawson'],
  },
  {
    retailerKey: 'ministop',
    retailerDisplayName: 'ミニストップ',
    matchPrefixes: ['ミニストップ', 'ministop'],
  },
  {
    retailerKey: 'aeon',
    retailerDisplayName: 'イオン',
    matchPrefixes: ['イオン', 'aeon'],
  },
] as const;

/** Map existing normalizeMerchant / canonicalizeMerchantChain outputs → retailerKey. */
const CANONICAL_DISPLAY_TO_RETAILER: Readonly<
  Record<string, { retailerKey: string; retailerDisplayName: string }>
> = {
  'セブン-イレブン': {
    retailerKey: 'seven_eleven',
    retailerDisplayName: 'セブン-イレブン',
  },
  ファミリーマート: {
    retailerKey: 'familymart',
    retailerDisplayName: 'ファミリーマート',
  },
  ローソン: { retailerKey: 'lawson', retailerDisplayName: 'ローソン' },
  ミニストップ: { retailerKey: 'ministop', retailerDisplayName: 'ミニストップ' },
  イオン: { retailerKey: 'aeon', retailerDisplayName: 'イオン' },
  コストコ: { retailerKey: 'costco', retailerDisplayName: 'コストコ' },
};

const UNRESOLVED: DerivedRetailerIdentity = {
  retailerKey: null,
  retailerDisplayName: null,
  storeHint: null,
  source: 'unresolved',
  confidence: 'unknown',
};

function toCompactMatchForm(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[－—–−ー\-]/g, '')
    .replace(/_/g, '');
}

function pickObservationTexts(input: DeriveRetailerIdentityInput): string[] {
  const out: string[] = [];
  const normalized = (input.merchantNormalized ?? '').trim();
  const raw = (input.merchantRaw ?? '').trim();
  // Prefer normalized first for retailer match; still keep raw for storeHint.
  if (normalized) out.push(normalized);
  if (raw && raw !== normalized) out.push(raw);
  else if (raw && !normalized) out.push(raw);
  return out;
}

function matchRegistryPrefix(
  text: string
): { rule: RetailerRule; matchedPrefix: string } | null {
  const compact = toCompactMatchForm(text);
  if (!compact) return null;

  let best: { rule: RetailerRule; matchedPrefix: string; len: number } | null =
    null;

  for (const rule of RETAILER_IDENTITY_REGISTRY) {
    for (const prefix of rule.matchPrefixes) {
      const p = toCompactMatchForm(prefix);
      if (!p) continue;
      if (!compact.startsWith(p)) continue;
      // Guard: bare generic スーパー must never resolve via gyomu rule.
      if (rule.retailerKey === 'gyomu_super' && !p.includes('業務') && !p.includes('gyomu')) {
        continue;
      }
      if (!best || p.length > best.len) {
        best = { rule, matchedPrefix: prefix, len: p.length };
      }
    }
  }
  return best ? { rule: best.rule, matchedPrefix: best.matchedPrefix } : null;
}

/**
 * Conservative residue after removing a known retailer prefix.
 * NOT a storeKey / verified branch id.
 *
 * Consumes the observation left-to-right while matching the compact prefix,
 * ignoring spaces/separators so "セブンイレブン" can strip against "セブン-イレブン".
 */
export function extractStoreHint(
  observation: string | null | undefined,
  matchedPrefix: string
): string | null {
  const original = (observation ?? '').trim();
  if (!original || !matchedPrefix) return null;

  const compactPrefix = toCompactMatchForm(matchedPrefix);
  if (!compactPrefix) return null;
  if (!toCompactMatchForm(original).startsWith(compactPrefix)) return null;

  let prefixIdx = 0;
  let cut = 0;
  for (let i = 0; i < original.length && prefixIdx < compactPrefix.length; i++) {
    const ch = original[i]!;
    if (/[\s　]/.test(ch)) {
      cut = i + 1;
      continue;
    }
    const unit = ch.normalize('NFKC').toLowerCase();
    // Separators in observation may be skipped if they are not part of the
    // compact prefix (e.g. hyphen already folded in compact form).
    if (/[・･\-－—–−ー_／/]/.test(unit)) {
      cut = i + 1;
      continue;
    }
    if (!compactPrefix.startsWith(unit, prefixIdx)) {
      return null;
    }
    prefixIdx += unit.length;
    cut = i + 1;
  }
  if (prefixIdx < compactPrefix.length) return null;

  let residue = original.slice(cut).trim();
  residue = residue.replace(/^[\s　・･\-－—–−ー_／/]+/, '').trim();
  if (!residue) return null;
  if (residue === '店') return null;
  return residue;
}

function bestStoreHint(
  texts: string[],
  matchedPrefix: string
): string | null {
  let best: string | null = null;
  for (const text of texts) {
    const hint = extractStoreHint(text, matchedPrefix);
    if (hint && (!best || hint.length > best.length)) best = hint;
  }
  // Also try display-name form of the rule when prefix was latin.
  return best;
}

function fromCanonicalDisplay(
  display: string,
  texts: string[]
): DerivedRetailerIdentity | null {
  const mapped = CANONICAL_DISPLAY_TO_RETAILER[display];
  if (!mapped) return null;
  const hint = bestStoreHint(texts, mapped.retailerDisplayName);
  return {
    retailerKey: mapped.retailerKey,
    retailerDisplayName: mapped.retailerDisplayName,
    storeHint: hint,
    source: 'existing_normalized',
    confidence: 'exact',
  };
}

/**
 * Derive stable retailer identity from receipt merchant evidence.
 * Pure / deterministic / side-effect free.
 */
export function deriveRetailerIdentity(
  input: DeriveRetailerIdentityInput
): DerivedRetailerIdentity {
  const texts = pickObservationTexts(input);
  if (texts.length === 0) return { ...UNRESOLVED };

  // 1) Explicit registry prefix rules (gyomu / york / etc.) on normalized then raw.
  for (const text of texts) {
    const hit = matchRegistryPrefix(text);
    if (!hit) continue;
    const hintTexts = [
      (input.merchantRaw ?? '').trim(),
      (input.merchantNormalized ?? '').trim(),
    ].filter(Boolean);
    const storeHint = bestStoreHint(
      hintTexts.length > 0 ? hintTexts : [text],
      hit.rule.retailerDisplayName
    );
    // If display-name prefix miss (e.g. matched latin), retry with matchedPrefix.
    const storeHintFinal =
      storeHint ??
      bestStoreHint(hintTexts.length > 0 ? hintTexts : [text], hit.matchedPrefix);
    return {
      retailerKey: hit.rule.retailerKey,
      retailerDisplayName: hit.rule.retailerDisplayName,
      storeHint: storeHintFinal,
      source: 'known_retailer_rule',
      confidence: 'exact',
    };
  }

  // 2) Reuse existing chain canonicalization without changing its outputs.
  const seed =
    (input.merchantNormalized ?? '').trim() ||
    (input.merchantRaw ?? '').trim();
  if (!seed) return { ...UNRESOLVED };

  const canonical = canonicalizeMerchantChain(seed);
  const fromCanon = fromCanonicalDisplay(canonical, texts);
  if (fromCanon) return fromCanon;

  // normalizeMerchant may equal canonicalize; keep as secondary check.
  const normalized = normalizeMerchant(seed);
  const fromNorm = fromCanonicalDisplay(normalized, texts);
  if (fromNorm) return fromNorm;

  return { ...UNRESOLVED };
}
