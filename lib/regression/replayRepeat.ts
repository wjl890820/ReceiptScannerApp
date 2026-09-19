/**
 * Phase 2 — offline Repeat V1 replay via production buildRepeatProductProfiles.
 */

import type { ReceiptRow } from '../db';
import { createMemoryProductIdentityStore } from '../productIdentityStore';
import {
  buildRepeatProductProfiles,
  type RepeatProductProfile,
  type RepeatProductRowInput,
} from '../repeatProductProfile';

export type RepeatReplayProfileProjection = {
  identityKind: RepeatProductProfile['identityKind'];
  identityKey: string;
  displayName: string;
  purchaseOccurrenceCount: number;
  totalPurchaseQuantity: number | null;
  firstPurchasedAt: number | null;
  lastPurchasedAt: number | null;
  datedPurchaseOccurrenceCount: number;
  purchaseEventDates: number[];
};

export type RepeatReplayResult = {
  profiles: RepeatReplayProfileProjection[];
  profileCount: number;
  merchantProductProfiles: number;
  personalProductProfiles: number;
  occurrenceDistribution: Record<string, number>;
  personalProduct: { status: 'disabled_offline_phase2_v1' };
};

function projectProfile(
  profile: RepeatProductProfile
): RepeatReplayProfileProjection {
  return {
    identityKind: profile.identityKind,
    identityKey: profile.identityKey,
    displayName: profile.displayName,
    purchaseOccurrenceCount: profile.purchaseOccurrenceCount,
    totalPurchaseQuantity:
      typeof profile.totalPurchaseQuantity === 'number'
        ? profile.totalPurchaseQuantity
        : null,
    firstPurchasedAt: profile.firstPurchasedAt,
    lastPurchasedAt: profile.lastPurchasedAt,
    datedPurchaseOccurrenceCount: profile.datedPurchaseOccurrenceCount,
    purchaseEventDates: [...profile.purchaseEventDates],
  };
}

/**
 * Replay Repeat V1 over analytics-retained receipts + filtered product rows.
 * personalInventory left null (unsupported offline Phase 2 v1).
 */
export function replayRepeatProfiles(input: {
  analyticsReceipts: readonly ReceiptRow[];
  productRows: readonly RepeatProductRowInput[];
  purchaseOccurrenceIndex?: import('../canonicalPurchaseOccurrence').CanonicalPurchaseOccurrenceIndex | null;
}): RepeatReplayResult {
  const store = createMemoryProductIdentityStore();
  const profiles = buildRepeatProductProfiles(
    input.analyticsReceipts,
    input.productRows,
    {
      personalInventory: null,
      identityStore: store,
      purchaseOccurrenceIndex: input.purchaseOccurrenceIndex,
    }
  );

  const projected = profiles.map(projectProfile);
  const occurrenceDistribution: Record<string, number> = {};
  let merchantProductProfiles = 0;
  let personalProductProfiles = 0;
  for (const p of projected) {
    const key = String(p.purchaseOccurrenceCount);
    occurrenceDistribution[key] = (occurrenceDistribution[key] ?? 0) + 1;
    if (p.identityKind === 'merchant_product') merchantProductProfiles += 1;
    if (p.identityKind === 'personal_product') personalProductProfiles += 1;
  }

  return {
    profiles: projected,
    profileCount: projected.length,
    merchantProductProfiles,
    personalProductProfiles,
    occurrenceDistribution,
    personalProduct: { status: 'disabled_offline_phase2_v1' },
  };
}
