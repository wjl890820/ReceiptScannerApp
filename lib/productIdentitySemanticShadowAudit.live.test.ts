/**
 * Optional dry-run for Batch 4.1 semantic gate + receipt cost (no Gemini on history).
 */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));
jest.mock('./env', () => ({
  getSupabaseUrl: () => '',
  getSupabaseAnonKey: () => '',
  isJwtLike: () => false,
  getCategoryBatchAiTimeoutMs: () => 9000,
  getCategoryBatchAiMaxItems: () => 40,
}));

import * as fs from 'fs';
import * as path from 'path';
import { buildDedupedShadowObservations } from './productIdentityShadowAuditDataset';
import { runSemanticShadowSelectionAudit } from './productIdentitySemanticShadowAudit';
import { runReceiptSemanticCostSimulation } from './productIdentitySemanticReceiptCost';
import { selectLiveEvalSamples } from './productIdentitySemanticLiveEval';

const ARTIFACT = path.join(__dirname, '../artifacts/product-intelligence-audit.json');

describe('Product Identity Batch 4.1 — semantic gate dry-run + receipt cost', () => {
  const hasArtifact = fs.existsSync(ARTIFACT);

  (hasArtifact ? it : it.skip)(
    'dry-runs calibrated gate over Analysis-D deduped V1 observations (932)',
    () => {
      const payload = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
      const { dataset, observations } = buildDedupedShadowObservations(payload, {
        applyV1MerchantFilter: true,
      });

      expect(dataset.storedReceiptCount).toBe(127);
      expect(dataset.duplicateExtrasExcluded).toBe(24);
      expect(dataset.purchaseCandidateCount).toBe(103);
      expect(dataset.v1SupportedPurchaseCandidateCount).toBe(99);
      expect(dataset.eligibleItemObservations).toBe(920);
      expect(observations.length).toBe(920);

      const semantic = runSemanticShadowSelectionAudit(observations);
      expect(semantic.geminiLiveCalls).toBe(0);
      expect(semantic.eligibleObservations).toBe(920);
      expect(semantic.distinctMerchantProducts).toBe(612); // A1.3.2 score-first Costco rep
      expect(semantic.ratioDistinctNeedingAi).toBeLessThan(0.55);

      const receiptCost = runReceiptSemanticCostSimulation(payload);
      expect(receiptCost.receiptCount).toBe(99);

      const liveSamplePlan = selectLiveEvalSamples(semantic.observations, {
        maxSamples: 28,
        controlMin: 5,
      });
      expect(liveSamplePlan.length).toBeGreaterThanOrEqual(20);
      expect(
        liveSamplePlan.filter((s) => !s.gateNeedsEnrichment).length
      ).toBeGreaterThanOrEqual(5);

      const outPath = path.join(
        __dirname,
        '../artifacts/product-identity-semantic-batch4.1-dryrun.json'
      );
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const summary = { dataset, semantic, receiptCost, liveSamplePlan };
      fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(summary, null, 2));
    }
  );
});
