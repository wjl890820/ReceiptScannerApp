/**
 * MERUNO ShoppingIntent domain (M1-D).
 *
 * ShoppingIntent = what the user may want to buy (planning).
 * Receipt / purchase = what already happened.
 *
 * rawText is authoritative. Semantic resolution is optional derived metadata.
 * Do not invent a second product identity / spec / price system.
 */

import { nanoid } from 'nanoid/non-secure';

import {
  resolveProductIdentity,
  type ProductIdentity,
} from './productIdentity';
import type { ProductFamilyKey } from './productFamily';
import {
  parseProductSpecification,
  type ProductSpecification,
} from './productSpecification';
import type { AggregatableProductDetailTarget } from './productDetailTarget';

export const SHOPPING_INTENT_CONTRACT_VERSION = 'meruno-shopping-intent-v1' as const;
export const SHOPPING_RESOLUTION_VERSION = 'meruno-shopping-resolution-v1' as const;

export type ShoppingIntentType = 'product' | 'note' | 'unknown';
export type ShoppingIntentStatus = 'active' | 'completed' | 'archived';
export type ShoppingResolutionLevel = 'family' | 'canonical' | 'unresolved';

export type ShoppingResolutionSource =
  | 'rule'
  | 'existing_identity'
  | 'manual'
  | 'unknown';

/**
 * Derived resolution. Replaceable by later resolvers / user override.
 * Precedence for effective identity: manual > derived > raw text only.
 */
export type ShoppingIntentResolution = {
  level: ShoppingResolutionLevel;
  familyKey: ProductFamilyKey | null;
  canonicalProductName: string | null;
  brand: string | null;
  /** Reserved; null in V1. */
  productType: string | null;
  resolutionSource: ShoppingResolutionSource;
  resolutionVersion: typeof SHOPPING_RESOLUTION_VERSION;
  resolutionConfidence: number | null;
};

export type ShoppingIntent = {
  id: string;
  rawText: string;
  intentType: ShoppingIntentType;
  status: ShoppingIntentStatus;
  /** Desired shopping quantity — NOT receipt purchase_quantity. */
  desiredQuantity: number | null;
  /** Desired package spec via M1-B parser — NOT a second spec system. */
  desiredSpec: ProductSpecification | null;
  resolution: ShoppingIntentResolution | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  contractVersion: typeof SHOPPING_INTENT_CONTRACT_VERSION;
};

export type CreateShoppingIntentInput = {
  rawText: string;
  /** Explicit user type override; otherwise derived. */
  intentType?: ShoppingIntentType;
  desiredQuantity?: number | null;
  /** Explicit product link outranks automatic resolution. */
  manualResolution?: Partial<
    Pick<
      ShoppingIntentResolution,
      'familyKey' | 'canonicalProductName' | 'brand' | 'productType'
    >
  > | null;
  now?: () => Date;
  idFactory?: () => string;
};

export type UpdateShoppingIntentInput = {
  rawText?: string;
  intentType?: ShoppingIntentType;
  desiredQuantity?: number | null;
  status?: ShoppingIntentStatus;
  manualResolution?: CreateShoppingIntentInput['manualResolution'];
  /** When true, re-derive resolution from rawText (manual still wins if provided). */
  reresolve?: boolean;
  now?: () => Date;
};

export type ListShoppingIntentsFilter = {
  status?: ShoppingIntentStatus | ShoppingIntentStatus[];
};

const NOTE_PATTERN =
  /记得|別忘|别忘|不要忘|明天|明日|週末|周末|あとで|忘れず|リマインド|reminder/i;

const VAGUE_NOTE_PATTERN = /聚会用品|パーティー用品|いろいろ|なんか|なんかいいの/i;

/** Trailing shopping quantity that is not a multipack unit marker (500ml×6). */
const DESIRED_QTY_TRAILING =
  /(?:^|[\s　])(?:[×xX＊*]\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:个|個|盒|瓶|本|袋|件|つ))\s*$/;

const UNIT_BEFORE_MULTIPLY =
  /(?:\d+(?:\.\d+)?)\s*(?:ml|l|g|kg|ｍｌ|ｌ|ｇ|ｋｇ)\s*[×xX＊*]\s*\d+/i;

export function toShoppingIntentIsoTimestamp(date = new Date()): string {
  return date.toISOString();
}

export function extractDesiredQuantity(rawText: string): number | null {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return null;
  if (UNIT_BEFORE_MULTIPLY.test(text)) return null;
  const match = text.match(DESIRED_QTY_TRAILING);
  if (!match) return null;
  const raw = match[1] ?? match[2];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function looksLikeNote(rawText: string): boolean {
  const text = rawText.trim();
  if (!text) return false;
  if (NOTE_PATTERN.test(text)) return true;
  if (VAGUE_NOTE_PATTERN.test(text)) return true;
  return false;
}

function levelFromIdentity(identity: ProductIdentity): ShoppingResolutionLevel {
  if (identity.canonicalProductName?.trim()) return 'canonical';
  if (identity.productFamilyKey) return 'family';
  return 'unresolved';
}

function sourceFromIdentity(identity: ProductIdentity): ShoppingResolutionSource {
  if (
    identity.identitySource === 'user_confirmed' ||
    identity.identitySource === 'merchant_alias' ||
    identity.identitySource === 'dictionary'
  ) {
    return 'existing_identity';
  }
  if (identity.identitySource === 'high_confidence_rule') return 'rule';
  if (identity.productFamilyKey) return 'rule';
  return 'unknown';
}

/**
 * Build optional derived resolution from existing identity + family rules.
 * Never invents shopping-specific identity keys.
 */
export function resolveShoppingIntentSemantics(rawText: string): {
  intentType: ShoppingIntentType;
  desiredQuantity: number | null;
  desiredSpec: ProductSpecification | null;
  resolution: ShoppingIntentResolution | null;
} {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  const desiredQuantity = extractDesiredQuantity(text);
  const desiredSpec = text ? parseProductSpecification(text) : null;
  const usableSpec =
    desiredSpec && desiredSpec.dimension !== 'unknown' ? desiredSpec : null;

  if (!text) {
    return {
      intentType: 'unknown',
      desiredQuantity: null,
      desiredSpec: null,
      resolution: {
        level: 'unresolved',
        familyKey: null,
        canonicalProductName: null,
        brand: null,
        productType: null,
        resolutionSource: 'unknown',
        resolutionVersion: SHOPPING_RESOLUTION_VERSION,
        resolutionConfidence: null,
      },
    };
  }

  if (looksLikeNote(text)) {
    return {
      intentType: 'note',
      desiredQuantity,
      desiredSpec: usableSpec,
      resolution: {
        level: 'unresolved',
        familyKey: null,
        canonicalProductName: null,
        brand: null,
        productType: null,
        resolutionSource: 'unknown',
        resolutionVersion: SHOPPING_RESOLUTION_VERSION,
        resolutionConfidence: null,
      },
    };
  }

  const identity = resolveProductIdentity({ rawName: text });
  const level = levelFromIdentity(identity);
  const resolution: ShoppingIntentResolution = {
    level,
    familyKey: identity.productFamilyKey,
    canonicalProductName: identity.canonicalProductName,
    brand: identity.brand,
    productType: null,
    resolutionSource: sourceFromIdentity(identity),
    resolutionVersion: SHOPPING_RESOLUTION_VERSION,
    resolutionConfidence:
      Number.isFinite(identity.identityConfidence) && identity.identityConfidence > 0
        ? identity.identityConfidence
        : identity.productFamilyKey
          ? 0.9
          : null,
  };

  const intentType: ShoppingIntentType =
    level === 'unresolved' ? 'unknown' : 'product';

  return {
    intentType,
    desiredQuantity,
    desiredSpec: usableSpec,
    resolution,
  };
}

function applyManualResolution(
  base: ShoppingIntentResolution | null,
  manual: CreateShoppingIntentInput['manualResolution']
): ShoppingIntentResolution | null {
  if (!manual) return base;
  const familyKey = manual.familyKey ?? base?.familyKey ?? null;
  const canonicalProductName =
    manual.canonicalProductName ?? base?.canonicalProductName ?? null;
  const brand = manual.brand ?? base?.brand ?? null;
  const productType = manual.productType ?? base?.productType ?? null;
  let level: ShoppingResolutionLevel = 'unresolved';
  if (canonicalProductName?.trim()) level = 'canonical';
  else if (familyKey) level = 'family';
  return {
    level,
    familyKey,
    canonicalProductName: canonicalProductName?.trim() || null,
    brand: brand?.trim() || null,
    productType: productType?.trim() || null,
    resolutionSource: 'manual',
    resolutionVersion: SHOPPING_RESOLUTION_VERSION,
    resolutionConfidence: 1,
  };
}

export function buildShoppingIntent(input: CreateShoppingIntentInput): ShoppingIntent {
  const rawText = typeof input.rawText === 'string' ? input.rawText : '';
  const now = input.now ? input.now() : new Date();
  const iso = toShoppingIntentIsoTimestamp(now);
  const derived = resolveShoppingIntentSemantics(rawText);
  const resolution = applyManualResolution(derived.resolution, input.manualResolution);
  const intentType = input.intentType ?? derived.intentType;
  const desiredQuantity =
    input.desiredQuantity !== undefined
      ? input.desiredQuantity
      : derived.desiredQuantity;

  return {
    id: (input.idFactory ?? (() => nanoid()))(),
    rawText,
    intentType,
    status: 'active',
    desiredQuantity,
    desiredSpec: derived.desiredSpec,
    resolution,
    createdAt: iso,
    updatedAt: iso,
    completedAt: null,
    contractVersion: SHOPPING_INTENT_CONTRACT_VERSION,
  };
}

export function applyShoppingIntentUpdate(
  intent: ShoppingIntent,
  patch: UpdateShoppingIntentInput
): ShoppingIntent {
  const now = patch.now ? patch.now() : new Date();
  const iso = toShoppingIntentIsoTimestamp(now);
  const rawText = patch.rawText !== undefined ? patch.rawText : intent.rawText;

  let intentType = intent.intentType;
  let desiredQuantity = intent.desiredQuantity;
  let desiredSpec = intent.desiredSpec;
  let resolution = intent.resolution;

  const shouldReresolve =
    patch.reresolve === true ||
    patch.rawText !== undefined ||
    patch.manualResolution !== undefined;

  if (shouldReresolve) {
    const derived = resolveShoppingIntentSemantics(rawText);
    desiredSpec = derived.desiredSpec;
    if (patch.desiredQuantity === undefined && patch.rawText !== undefined) {
      desiredQuantity = derived.desiredQuantity;
    }
    if (patch.intentType === undefined && patch.rawText !== undefined) {
      intentType = derived.intentType;
    }
    const keepManual =
      intent.resolution?.resolutionSource === 'manual' &&
      patch.manualResolution === undefined &&
      patch.rawText === undefined;
    resolution = keepManual
      ? intent.resolution
      : applyManualResolution(derived.resolution, patch.manualResolution);
  }

  if (patch.intentType !== undefined) intentType = patch.intentType;
  if (patch.desiredQuantity !== undefined) desiredQuantity = patch.desiredQuantity;

  let status = patch.status ?? intent.status;
  let completedAt = intent.completedAt;
  if (status === 'completed' && intent.status !== 'completed') {
    completedAt = iso;
  } else if (status !== 'completed') {
    completedAt = null;
  }

  return {
    ...intent,
    rawText,
    intentType,
    status,
    desiredQuantity,
    desiredSpec,
    resolution,
    updatedAt: iso,
    completedAt,
  };
}

export function markShoppingIntentCompleted(
  intent: ShoppingIntent,
  now: () => Date = () => new Date()
): ShoppingIntent {
  return applyShoppingIntentUpdate(intent, { status: 'completed', now });
}

export function markShoppingIntentArchived(
  intent: ShoppingIntent,
  now: () => Date = () => new Date()
): ShoppingIntent {
  return applyShoppingIntentUpdate(intent, { status: 'archived', now });
}

/**
 * Map resolved intent → existing ProductDetailTarget for price history.
 * Does not cache prices on the intent.
 */
export function shoppingIntentToPriceHistoryTarget(
  intent: Pick<ShoppingIntent, 'resolution'>
): AggregatableProductDetailTarget | null {
  const resolution = intent.resolution;
  if (!resolution || resolution.level === 'unresolved') return null;
  if (resolution.level === 'canonical' && resolution.canonicalProductName?.trim()) {
    return { type: 'canonical', key: resolution.canonicalProductName.trim() };
  }
  if (resolution.familyKey) {
    return { type: 'family', key: resolution.familyKey };
  }
  return null;
}

/** Future purchase-matching keys — family preferred over raw string equality. */
export function shoppingIntentMatchKeys(intent: ShoppingIntent): {
  familyKey: string | null;
  canonicalProductName: string | null;
  brand: string | null;
  desiredSpecDimension: string | null;
  rawText: string;
} {
  return {
    familyKey: intent.resolution?.familyKey ?? null,
    canonicalProductName: intent.resolution?.canonicalProductName ?? null,
    brand: intent.resolution?.brand ?? null,
    desiredSpecDimension: intent.desiredSpec?.dimension ?? null,
    rawText: intent.rawText,
  };
}

/** Privacy: never put shopping contents into Product Analytics payloads. */
export function stripShoppingIntentForAnalyticsExport(intent: ShoppingIntent): {
  id: string;
  intentType: ShoppingIntentType;
  status: ShoppingIntentStatus;
  hasResolution: boolean;
  resolutionLevel: ShoppingResolutionLevel | null;
  contractVersion: typeof SHOPPING_INTENT_CONTRACT_VERSION;
} {
  return {
    id: intent.id,
    intentType: intent.intentType,
    status: intent.status,
    hasResolution: intent.resolution != null && intent.resolution.level !== 'unresolved',
    resolutionLevel: intent.resolution?.level ?? null,
    contractVersion: SHOPPING_INTENT_CONTRACT_VERSION,
  };
}

export function assertNoPriceSnapshotAsTruth(intent: ShoppingIntent): void {
  const json = JSON.stringify(intent);
  for (const forbidden of [
    'lastPrice',
    'lowestPrice',
    'averagePrice',
    'cachedPrice',
    'priceSnapshot',
  ]) {
    if (json.includes(`"${forbidden}"`)) {
      throw new Error(`ShoppingIntent must not store ${forbidden} as domain truth`);
    }
  }
}
