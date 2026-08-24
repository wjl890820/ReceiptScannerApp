/**
 * Product Identity Batch 5A — live shadow dual-run on Analysis D (932).
 * Shadow only. Gemini = 0. No UI / DB writes.
 */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';
import { buildDedupedShadowObservations } from './productIdentityShadowAuditDataset';
import {
  enrichObservationsForPriceShadow,
  runPriceComparisonShadowAudit,
} from './productIdentityPriceComparisonShadowAudit';

const ARTIFACT = path.join(
  __dirname,
  '../artifacts/product-intelligence-audit.json'
);

describe('Product Identity Batch 5A — price comparison shadow audit', () => {
  const hasArtifact = fs.existsSync(ARTIFACT);

  (hasArtifact ? it : it.skip)(
    'dual-runs universal comparison engine over 932 observations',
    () => {
      const payload = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
      const { dataset, observations } = buildDedupedShadowObservations(payload, {
        applyV1MerchantFilter: true,
      });

      expect(dataset.storedReceiptCount).toBe(127);
      expect(dataset.duplicateExtrasExcluded).toBe(23);
      expect(dataset.purchaseCandidateCount).toBe(104);
      expect(dataset.v1SupportedPurchaseCandidateCount).toBe(100);
      expect(dataset.eligibleItemObservations).toBe(932);

      const enriched = enrichObservationsForPriceShadow(observations, payload);
      const report = runPriceComparisonShadowAudit(enriched, dataset);

      expect(report.geminiAdditionalCalls).toBe(0);
      expect(report.userVisibleBehaviorChange).toBe(false);
      expect(report.identityBaseline.distinctMerchantProducts).toBe(610); // RC hardening: was 608
      expect(report.identityBaseline.productExact).toBe(0);
      expect(report.identityBaseline.skuExact).toBe(0);
      expect(report.examples.length).toBeGreaterThanOrEqual(20);
      expect(report.top10HighFrequencyMps.length).toBeGreaterThanOrEqual(1);
      expect(report.topPriceJumps.length).toBeGreaterThanOrEqual(1);

      // Price value usable (legacy) should remain ~932
      expect(report.legacyVsNew.legacyPurchaseUnitUsable).toBe(932);

      const outPath = path.join(
        __dirname,
        '../artifacts/product-identity-price-comparison-batch5a-shadow.json'
      );
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            strongest: report.strongestStrategyDistribution,
            capabilities: report.capabilityCounts,
            mpHistory: report.merchantProductHistory,
            unitNorm: report.unitNormalizationCoverage,
            legacyVsNew: report.legacyVsNew,
            unsupported: report.unsupportedReasonDistribution,
            topMp0: report.top10HighFrequencyMps[0],
            jump0: report.topPriceJumps[0],
            recommendations: report.recommendationFor5B,
          },
          null,
          2
        )
      );
    }
  );
});
