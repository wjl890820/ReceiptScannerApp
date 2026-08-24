import * as fs from 'fs';
import * as path from 'path';

import type { ReceiptRow } from './db';
import {
  buildHomeProgressiveExperience,
  resolveProgressiveHomeStage,
} from './homeProgressiveExperience';

function receipt(
  id: string,
  merchantType: ReceiptRow['merchant_type'] = 'supermarket'
): ReceiptRow {
  const index = Number(id.replace(/\D/g, '')) || 1;
  return {
    id,
    created_at: index * 1000,
    transaction_at: index * 1000,
    image_uri: '',
    total: 100 * index,
    tax: 0,
    currency: 'JPY',
    analysis_json: JSON.stringify({
      items: [
        {
          name: `Item ${id}`,
          lineTotal: 100 * index,
          quantity: 1,
          category: 'food_ingredients',
        },
      ],
    }),
    merchant_raw: `Store ${id}`,
    merchant_normalized: `store ${id}`,
    merchant_type: merchantType,
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  };
}

describe('progressive Home stage model', () => {
  it.each([
    [0, 'empty'],
    [1, 'first'],
    [2, 'building'],
    [3, 'recent'],
    [4, 'recent'],
    [5, 'frequent'],
    [9, 'frequent'],
    [10, 'profile'],
    [11, 'profile'],
  ] as const)('maps %s supported receipts to %s', (count, expected) => {
    expect(resolveProgressiveHomeStage(count)).toBe(expected);
    const receipts = Array.from({ length: count }, (_, index) =>
      receipt(`r${index + 1}`, index % 2 ? 'convenience' : 'supermarket')
    );
    expect(buildHomeProgressiveExperience(receipts, null).stage).toBe(
      expected
    );
  });

  it('excludes other and unknown receipts from progress', () => {
    const experience = buildHomeProgressiveExperience(
      [
        receipt('supported', 'convenience'),
        receipt('other', 'other'),
        receipt('unknown', 'unknown'),
      ],
      null
    );
    expect(experience.stage).toBe('first');
    expect(experience.status.supportedReceiptCount).toBe(1);
  });

  it('uses the newest supported receipt and tolerates incomplete backfill data', () => {
    const older = receipt('r1');
    const newer = {
      ...receipt('r2', 'convenience'),
      user_items_json: null,
      analysis_json: '{}',
    };
    const experience = buildHomeProgressiveExperience(
      [older, newer],
      null
    );
    expect(experience.latestPurchase?.receiptId).toBe('r2');
    expect(experience.latestPurchase?.itemCount).toBe(0);
  });

  it('keeps the stage and scan-ready view model when analytics fail', () => {
    const experience = buildHomeProgressiveExperience(
      [receipt('r1'), receipt('r2'), receipt('r3')],
      null,
      true
    );
    expect(experience.stage).toBe('recent');
    expect(experience.analyticsUnavailable).toBe(true);
    expect(experience.latestPurchase).not.toBeNull();
  });
});

describe('progressive Home integration boundaries', () => {
  it('keeps the existing scan, batch, retry, recovery, and review wiring', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../app/(tabs)/index.tsx'),
      'utf8'
    );
    expect(source).toContain('runScanPipelineToReview');
    expect(source).toContain('allowsMultipleSelection: true');
    expect(source).toContain('processMultipleReceiptImages');
    expect(source).toContain('retryFailedImages');
    expect(source).toContain('retryAllImages');
    expect(source).toContain('getPendingScanReviewState');
    expect(source).toContain('router.push(`/scan-review/${result.draftId}`');
    expect(source).toContain('onScan={handleScanReceipt}');
  });

  it('keeps the new Home presentation deterministic and offline', () => {
    const files = [
      'homeProgressiveExperience.ts',
      '../components/ProgressiveHomeInsights.tsx',
      '../components/MilestoneProgressCard.tsx',
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
      expect(source).not.toMatch(
        /openai|anthropic|supabase|fetch\s*\(|axios|payment|paywall/i
      );
    }
  });

  it('identity Frequent card model: 18 purchases → quantity 47 (not hardcoded 0)', () => {
    const { buildIdentityFrequentProductGroups } =
      require('./productIdentityConsumer') as typeof import('./productIdentityConsumer');
    const observations = Array.from({ length: 18 }, (_, i) => ({
      receiptId: `yoko-${i + 1}`,
      itemSourceIndex: 0,
      rawName: '横浜家系',
      merchantKey: 'ramen-shop',
      occurredAt: 1_700_000_000_000 + i * 86_400_000,
      lineTotal: 800,
      quantity: i === 0 ? 30 : 1,
    }));
    const { groups } = buildIdentityFrequentProductGroups(observations);
    expect(groups).toHaveLength(1);

    // Same mapping used by buildHomeLongTermFrequentProducts identity path.
    const card = {
      purchaseOccurrenceCount: groups[0]!.distinctReceiptCount,
      totalPurchaseQuantity: groups[0]!.totalPurchaseQuantity,
    };
    expect(card.purchaseOccurrenceCount).toBe(18);
    expect(card.totalPurchaseQuantity).toBe(47);

    const homeSource = fs.readFileSync(
      path.resolve(__dirname, 'homeProgressiveExperience.ts'),
      'utf8'
    );
    expect(homeSource).toContain('totalPurchaseQuantity: g.totalPurchaseQuantity');
    expect(homeSource).not.toMatch(
      /totalPurchaseQuantity:\s*0\s*,\s*\n\s*lastPurchasedAt: g\.latestPurchaseAt/
    );
  });
});
