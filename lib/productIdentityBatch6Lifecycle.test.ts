/**
 * Product Identity Batch 6 — lifecycle fixtures.
 * cold start / upgrade / reset / edit / delete / same-day / offline / restore.
 * No Gemini calls. Fixes confirmed bugs only (none expected here).
 */

import {
  buildIdentityFrequentProductGroups,
  buildIdentityMerchantProductHistoryView,
  resolveIdentityConsumerObservations,
} from './productIdentityConsumer';
import { resolvePricePresentation } from './productIdentityPresentationContract';
import { resolveReceiptItemIdentity } from './productIdentityResolver';
import {
  createMemoryProductIdentityStore,
  deterministicMerchantProductId,
} from './productIdentityStore';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';

function obs(partial: {
  receiptId: string;
  rawName: string;
  merchantKey: string;
  occurredAt: number;
  lineTotal: number;
  quantity?: number;
  itemSourceIndex?: number;
}) {
  return {
    receiptId: partial.receiptId,
    itemSourceIndex: partial.itemSourceIndex ?? 0,
    rawName: partial.rawName,
    merchantKey: partial.merchantKey,
    occurredAt: partial.occurredAt,
    lineTotal: partial.lineTotal,
    quantity: partial.quantity ?? 1,
  };
}

describe('Product Identity Batch 6 — lifecycle', () => {
  it('cold start: empty → first MP no history; second receipt → reuse + history', () => {
    const store = createMemoryProductIdentityStore();
    expect(store.listMerchantProducts('店').length).toBe(0);

    const first = resolveReceiptItemIdentity(
      {
        rawName: 'テスト牛乳1L',
        merchantKey: '店',
        receiptId: 'r1',
        itemSourceIndex: 0,
        quantity: 1,
        lineTotal: 200,
      },
      store
    );
    expect(first.link.merchantProductId).toBeTruthy();

    const rows1 = [
      obs({
        receiptId: 'r1',
        rawName: 'テスト牛乳1L',
        merchantKey: '店',
        occurredAt: Date.parse('2026-01-01'),
        lineTotal: 200,
      }),
    ];
    const { qualified: q1 } = resolveIdentityConsumerObservations(rows1, store);
    const view1 = buildIdentityMerchantProductHistoryView(
      q1[0]!.merchantProductId,
      q1
    );
    expect(view1?.priceHistoryEligible ?? false).toBe(false);

    const second = resolveReceiptItemIdentity(
      {
        rawName: 'テスト牛乳1L',
        merchantKey: '店',
        receiptId: 'r2',
        itemSourceIndex: 0,
        quantity: 1,
        lineTotal: 210,
      },
      store
    );
    expect(second.link.merchantProductId).toBe(first.link.merchantProductId);
    expect(second.reason).not.toBe('new_merchant_entity');

    const rows2 = [
      ...rows1,
      obs({
        receiptId: 'r2',
        rawName: 'テスト牛乳1L',
        merchantKey: '店',
        occurredAt: Date.parse('2026-02-01'),
        lineTotal: 210,
      }),
    ];
    const { qualified: q2 } = resolveIdentityConsumerObservations(rows2);
    const view2 = buildIdentityMerchantProductHistoryView(
      q2[0]!.merchantProductId,
      q2
    );
    expect(view2?.priceHistoryEligible).toBe(true);
    expect(view2!.historyPoints.length).toBeGreaterThanOrEqual(2);
  });

  it('upgrade: empty identity + existing receipt rows resolve without crash', () => {
    const store = createMemoryProductIdentityStore();
    const legacy = [
      obs({
        receiptId: 'legacy1',
        rawName: '肉まん',
        merchantKey: 'ヨークベニマル',
        occurredAt: Date.parse('2025-12-01'),
        lineTotal: 216,
      }),
      obs({
        receiptId: 'legacy2',
        rawName: '肉まん',
        merchantKey: 'ヨークベニマル',
        occurredAt: Date.parse('2026-01-01'),
        lineTotal: 230,
      }),
    ];
    const { qualified } = resolveIdentityConsumerObservations(legacy, store);
    expect(qualified.length).toBe(2);
    expect(qualified[0]!.merchantProductId).toBe(
      qualified[1]!.merchantProductId
    );
    const { groups } = buildIdentityFrequentProductGroups(legacy, store);
    expect(groups.length).toBe(1);
    expect(groups[0]!.distinctReceiptCount).toBe(2);
  });

  it('derived reset/rebuild is deterministic', () => {
    const input = {
      rawName: '東北恵牛乳1L',
      merchantKey: 'ヨークベニマル',
      receiptId: 'r1',
      itemSourceIndex: 0,
      quantity: 1,
      lineTotal: 200,
    };
    const storeA = createMemoryProductIdentityStore();
    const a = resolveReceiptItemIdentity(input, storeA);
    storeA.clearDerived();
    const a2 = resolveReceiptItemIdentity(input, storeA);

    const storeB = createMemoryProductIdentityStore();
    const b = resolveReceiptItemIdentity(input, storeB);

    expect(a.link.merchantProductId).toBe(a2.link.merchantProductId);
    expect(a.link.merchantProductId).toBe(b.link.merchantProductId);

    const cmp = normalizeProductForIdentity(input.rawName).comparisonKey;
    expect(a.link.merchantProductId).toBe(
      deterministicMerchantProductId(input.merchantKey, cmp)
    );
  });

  it('user edit changes fingerprint and does not reuse stale link', () => {
    const store = createMemoryProductIdentityStore();
    const first = resolveReceiptItemIdentity(
      {
        rawName: '商品A',
        merchantKey: '店',
        receiptId: 'r1',
        itemSourceIndex: 0,
        quantity: 1,
        lineTotal: 100,
      },
      store
    );
    const edited = resolveReceiptItemIdentity(
      {
        rawName: '商品A改',
        merchantKey: '店',
        receiptId: 'r1',
        itemSourceIndex: 0,
        quantity: 2,
        lineTotal: 180,
      },
      store
    );
    expect(edited.fingerprint).not.toBe(first.fingerprint);
    expect(edited.reason).not.toBe('cache_hit');
    const link = store.getLink('r1', 0);
    expect(link?.itemFingerprint).toBe(edited.fingerprint);
    expect(link?.stale).toBe(false);
  });

  it('receipt delete removes observations from frequent + history', () => {
    const all = [
      obs({
        receiptId: 'keep',
        rawName: 'えのき',
        merchantKey: 'コストコ',
        occurredAt: Date.parse('2026-01-01'),
        lineTotal: 298,
      }),
      obs({
        receiptId: 'deleted',
        rawName: 'えのき',
        merchantKey: 'コストコ',
        occurredAt: Date.parse('2026-02-01'),
        lineTotal: 298,
      }),
      obs({
        receiptId: 'keep2',
        rawName: 'えのき',
        merchantKey: 'コストコ',
        occurredAt: Date.parse('2026-03-01'),
        lineTotal: 298,
      }),
    ];
    const before = buildIdentityFrequentProductGroups(all);
    expect(before.groups[0]!.distinctReceiptCount).toBe(3);

    const afterDelete = all.filter((r) => r.receiptId !== 'deleted');
    const after = buildIdentityFrequentProductGroups(afterDelete);
    expect(after.groups[0]!.distinctReceiptCount).toBe(2);

    const { qualified } = resolveIdentityConsumerObservations(afterDelete);
    const view = buildIdentityMerchantProductHistoryView(
      qualified[0]!.merchantProductId,
      qualified
    );
    expect(view!.historyPoints.every((p) => p.receiptId !== 'deleted')).toBe(
      true
    );
  });

  it('same-day non-duplicate receipts with same MP create two observations', () => {
    const day = Date.parse('2026-06-01T10:00:00+09:00');
    const rows = [
      obs({
        receiptId: 'morning',
        rawName: '肉まん',
        merchantKey: 'ヨークベニマル',
        occurredAt: day,
        lineTotal: 216,
      }),
      obs({
        receiptId: 'evening',
        rawName: '肉まん',
        merchantKey: 'ヨークベニマル',
        occurredAt: day + 8 * 3600_000,
        lineTotal: 216,
      }),
    ];
    const { qualified } = resolveIdentityConsumerObservations(rows);
    expect(qualified.length).toBe(2);
    expect(qualified[0]!.merchantProductId).toBe(
      qualified[1]!.merchantProductId
    );
    const { groups } = buildIdentityFrequentProductGroups(rows);
    expect(groups[0]!.distinctReceiptCount).toBe(2);
  });

  it('offline browse: history/frequent work; copy stays merchant-local', () => {
    const rows = [
      obs({
        receiptId: 'a',
        rawName: 'チョコ棒',
        merchantKey: 'ヨークベニマル',
        occurredAt: Date.parse('2026-01-01'),
        lineTotal: 192,
      }),
      obs({
        receiptId: 'b',
        rawName: 'チョコ棒',
        merchantKey: 'ヨークベニマル',
        occurredAt: Date.parse('2026-02-01'),
        lineTotal: 192,
      }),
    ];
    const { groups } = buildIdentityFrequentProductGroups(rows);
    const { qualified } = resolveIdentityConsumerObservations(rows);
    const view = buildIdentityMerchantProductHistoryView(
      qualified[0]!.merchantProductId,
      qualified
    );
    expect(groups.length).toBe(1);
    expect(view?.priceHistoryEligible).toBe(true);
    const copy = resolvePricePresentation('same_merchant_product');
    expect(copy.allowsCrossMerchantClaim).toBe(false);
    expect(copy.strength).toBe('merchant_local');
    expect(copy.titleKey).toBe('priceHistory.titleMerchantLocal');
  });

  it('restore path: identity rebuildable from receipt truth', () => {
    const receiptTruth = [
      obs({
        receiptId: 'restored-1',
        rawName: 'ロティサリーチキン',
        merchantKey: 'コストコ',
        occurredAt: Date.parse('2026-01-01'),
        lineTotal: 899,
      }),
      obs({
        receiptId: 'restored-2',
        rawName: 'ロティサリーチキン',
        merchantKey: 'コストコ',
        occurredAt: Date.parse('2026-02-01'),
        lineTotal: 899,
      }),
    ];
    const store1 = createMemoryProductIdentityStore();
    const pass1 = resolveIdentityConsumerObservations(receiptTruth, store1);
    store1.clearDerived();
    const store2 = createMemoryProductIdentityStore();
    const pass2 = resolveIdentityConsumerObservations(receiptTruth, store2);
    expect(pass1.qualified[0]!.merchantProductId).toBe(
      pass2.qualified[0]!.merchantProductId
    );
    expect(pass1.qualified.length).toBe(pass2.qualified.length);
  });

  it('semantic cache clear does not drop receipt truth / history rebuild', () => {
    const rows = [
      obs({
        receiptId: 's1',
        rawName: 'さつま揚げ',
        merchantKey: '店',
        occurredAt: Date.parse('2026-01-01'),
        lineTotal: 198,
      }),
      obs({
        receiptId: 's2',
        rawName: 'さつま揚げ',
        merchantKey: '店',
        occurredAt: Date.parse('2026-02-01'),
        lineTotal: 198,
      }),
    ];
    const store = createMemoryProductIdentityStore();
    const first = resolveIdentityConsumerObservations(rows, store);
    const mpId = first.qualified[0]!.merchantProductId;
    // Clearing derived/semantic cache must leave callers able to rebuild.
    store.clearDerived();
    const rebuilt = resolveIdentityConsumerObservations(rows);
    expect(rebuilt.qualified[0]!.merchantProductId).toBe(mpId);
    const view = buildIdentityMerchantProductHistoryView(
      mpId,
      rebuilt.qualified
    );
    expect(view?.priceHistoryEligible).toBe(true);
  });
});
