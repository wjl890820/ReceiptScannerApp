/**
 * Build 53 — section micro-label catalog (visual identifiers only).
 * Localized titles remain the primary user-facing copy via i18n.
 */

export const SECTION_MICRO = {
  home: {
    quickScan: '01 / QUICK SCAN',
    recent: '02 / RECENT',
    profile: '03 / PROFILE',
    frequent: '04 / FREQUENT',
  },
  analysis: {
    overview: '01 / OVERVIEW',
    category: '02 / CATEGORY',
    merchant: '03 / MERCHANT',
    change: '04 / CHANGE',
    insight: '05 / INSIGHT',
  },
  product: {
    summary: '01 / SUMMARY',
    priceLog: '02 / PRICE LOG',
    records: '03 / RECORDS',
  },
  settings: {
    account: '01 / ACCOUNT',
    preferences: '02 / PREFERENCES',
    support: '03 / SUPPORT',
  },
} as const;

/** @deprecated alias — prefer SECTION_MICRO */
export const SECTION_MICRO_LABELS = SECTION_MICRO;
