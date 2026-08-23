/**
 * Product Identity Batch 3.1 — shadow metric clarification tests.
 */

import {
  AUDIT_FUZZY_PROBE_FLOOR,
  observationsFromProductIntelligenceExport,
  runShadowIdentityAudit,
} from './productIdentityShadowAudit';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import { FUZZY_AUTO_MATCH_THRESHOLD } from './productIdentityResolver';

describe('Product Identity Batch 3.1 — metric clarification', () => {
  it('keeps audit probe floor below resolver auto-match (observation only)', () => {
    expect(AUDIT_FUZZY_PROBE_FLOOR).toBeLessThan(FUZZY_AUTO_MATCH_THRESHOLD);
    expect(AUDIT_FUZZY_PROBE_FLOOR).toBe(0.75);
  });

  it('splits existingMatch vs newEntity (reuse ≠ coverage)', () => {
    const store = createMemoryProductIdentityStore();
    const observations = observationsFromProductIntelligenceExport({
      receipts: [
        { id: 'r1', merchant_normalized: 'ヨークベニマル' },
        { id: 'r2', merchant_normalized: 'ヨークベニマル' },
      ],
      receiptItems: [
        {
          receipt_id: 'r1',
          source_index: 0,
          raw_name: '東北恵牛乳1L',
          quantity: 1,
          line_total: 198,
        },
        {
          receipt_id: 'r2',
          source_index: 0,
          raw_name: '東北恵 牛乳１０００ＭＬ',
          quantity: 1,
          line_total: 205,
        },
        {
          receipt_id: 'r2',
          source_index: 1,
          raw_name: '謎商品XYZ',
          quantity: 1,
          line_total: 99,
        },
      ],
    });

    const report = runShadowIdentityAudit(observations, store);

    expect(report.entityAssignment.merchantProductNewEntity).toBeGreaterThan(0);
    expect(
      report.entityAssignment.merchantProductExistingMatch +
        report.entityAssignment.merchantProductNewEntity
    ).toBe(report.entityAssignment.merchantProductTotalAssigned);

    expect(report.reuseQuality.merchantProductReuseRate).toBeGreaterThanOrEqual(
      0
    );
    expect(report.reuseQuality.merchantProductReuseRate).toBeLessThanOrEqual(1);

    const actionSum = Object.values(report.byAction).reduce((a, b) => a + b, 0);
    const levelSum = Object.values(report.byLevel).reduce((a, b) => a + b, 0);
    expect(actionSum).toBe(observations.length);
    expect(levelSum).toBe(observations.length);

    expect(report.entityAssignment.canonicalNewEntity).toBe(0);

    expect(
      report.fixtureConflictSamples.every(
        (s) => s.resolverDecision === 'rejected'
      )
    ).toBe(true);

    expect(report.geminiAdditionalCalls).toBe(0);
  });

  it('does not invent dataset counts without Analysis-D selection', () => {
    const observations = observationsFromProductIntelligenceExport({
      receipts: [{ id: 'r1', merchant_normalized: 'イオン' }],
      receiptItems: [
        { receipt_id: 'r1', source_index: 0, raw_name: '牛乳1L' },
      ],
    });
    const report = runShadowIdentityAudit(observations);
    expect(report.dataset.storedReceiptCount).toBe(0);
    expect(report.dataset.eligibleItemObservations).toBe(1);
  });
});

describe('Product Identity Batch 3.1 — no resolver threshold change', () => {
  it('does not lower fuzzy auto-match for coverage', () => {
    expect(FUZZY_AUTO_MATCH_THRESHOLD).toBeGreaterThanOrEqual(0.98);
  });
});
