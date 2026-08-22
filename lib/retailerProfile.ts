/**
 * R1-B3a — Derived retailer profile metadata (additive, recomputable, non-persistent).
 *
 * Domain SSOT: docs/merchant-domain-contract.md
 *
 * RetailerProfile sits on top of DerivedRetailerIdentity.retailerKey.
 * It does NOT replace merchant_type, V1 eligibility, or merchantAnalyticsKey.
 * Not wired into UI / analytics / Product Detail / ShoppingIntent in B3a.
 *
 * No DB / network / AI. Pure functions only.
 */

/** Retailer keys established by R1-B2 (`lib/retailerIdentity.ts`). */
export type RetailerKey =
  | 'costco'
  | 'gyomu_super'
  | 'york_benimaru'
  | 'seven_eleven'
  | 'familymart'
  | 'lawson'
  | 'ministop'
  | 'aeon';

/**
 * Descriptive retailer business format — NOT merchant_type / V1 eligibility.
 *
 * Example: Costco may have merchant_type=supermarket on the receipt while
 * RetailerProfile.retailerFormat=warehouse_club.
 */
export type RetailerFormat =
  | 'supermarket'
  | 'convenience'
  | 'warehouse_club';

/**
 * Stable descriptive retailer metadata.
 *
 * NOT merchant_type, NOT V1 eligibility, NOT receipt intent,
 * NOT user behavior, NOT physical-store identity.
 */
export type RetailerProfile = {
  retailerKey: RetailerKey;
  displayName: string;
  retailerFormat: RetailerFormat;
  /**
   * Ordinary shopping at this retailer generally requires membership
   * as part of the retailer format. NOT the user's membership status.
   */
  membershipRequired: boolean;
  /**
   * Retailer format is materially oriented toward bulk / large-pack purchasing.
   * NOT a per-receipt stock-up label or user preference.
   */
  bulkPurchaseFormat: boolean;
};

/**
 * Explicit profile registry (SSOT for R1-B3a).
 * Only the eight R1-B2 retailer keys — no invented national catalog.
 */
export const RETAILER_PROFILE_REGISTRY: readonly RetailerProfile[] = [
  {
    retailerKey: 'costco',
    displayName: 'コストコ',
    retailerFormat: 'warehouse_club',
    membershipRequired: true,
    bulkPurchaseFormat: true,
  },
  {
    retailerKey: 'gyomu_super',
    displayName: '業務スーパー',
    retailerFormat: 'supermarket',
    membershipRequired: false,
    bulkPurchaseFormat: true,
  },
  {
    retailerKey: 'york_benimaru',
    displayName: 'ヨークベニマル',
    retailerFormat: 'supermarket',
    membershipRequired: false,
    bulkPurchaseFormat: false,
  },
  {
    retailerKey: 'seven_eleven',
    displayName: 'セブン-イレブン',
    retailerFormat: 'convenience',
    membershipRequired: false,
    bulkPurchaseFormat: false,
  },
  {
    retailerKey: 'familymart',
    displayName: 'ファミリーマート',
    retailerFormat: 'convenience',
    membershipRequired: false,
    bulkPurchaseFormat: false,
  },
  {
    retailerKey: 'lawson',
    displayName: 'ローソン',
    retailerFormat: 'convenience',
    membershipRequired: false,
    bulkPurchaseFormat: false,
  },
  {
    retailerKey: 'ministop',
    displayName: 'ミニストップ',
    retailerFormat: 'convenience',
    membershipRequired: false,
    bulkPurchaseFormat: false,
  },
  {
    retailerKey: 'aeon',
    displayName: 'イオン',
    retailerFormat: 'supermarket',
    membershipRequired: false,
    bulkPurchaseFormat: false,
  },
] as const;

const PROFILE_BY_KEY: ReadonlyMap<string, RetailerProfile> = new Map(
  RETAILER_PROFILE_REGISTRY.map((p) => [p.retailerKey, p])
);

/**
 * Lookup objective RetailerProfile by retailerKey.
 * Returns null for unresolved / unknown keys — never invents metadata.
 */
export function getRetailerProfile(
  retailerKey: string | null | undefined
): RetailerProfile | null {
  if (retailerKey == null || retailerKey === '') return null;
  return PROFILE_BY_KEY.get(retailerKey) ?? null;
}
