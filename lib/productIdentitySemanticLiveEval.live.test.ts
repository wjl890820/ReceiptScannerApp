/**
 * Optional LIVE Gemini eval (Batch 4.1).
 * Enable: RUN_SEMANTIC_LIVE_EVAL=1 with real Supabase env.
 */
(global as unknown as { __DEV__: boolean }).__DEV__ = false;
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('expo-constants', () => ({
  default: { expoConfig: { extra: {} }, manifest: null },
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';
import { buildDedupedShadowObservations } from './productIdentityShadowAuditDataset';
import { runSemanticShadowSelectionAudit } from './productIdentitySemanticShadowAudit';
import {
  autoReviewLiveEval,
  callSemanticEnrichLive,
  canRunLiveSemanticEval,
  selectLiveEvalSamples,
} from './productIdentitySemanticLiveEval';

const ARTIFACT = path.join(__dirname, '../artifacts/product-intelligence-audit.json');
const OUT = path.join(
  __dirname,
  '../artifacts/product-identity-semantic-batch4.1-live-eval.json'
);

describe('Product Identity Batch 4.1 — live Gemini semantic eval (optional)', () => {
  const enabled = canRunLiveSemanticEval() && fs.existsSync(ARTIFACT);

  (enabled ? it : it.skip)(
    'calls classify-items mode=semantic_enrich for 20–28 samples',
    async () => {
      const payload = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
      const { observations } = buildDedupedShadowObservations(payload, {
        applyV1MerchantFilter: true,
      });
      const semantic = runSemanticShadowSelectionAudit(observations);
      const samples = selectLiveEvalSamples(semantic.observations, {
        maxSamples: 28,
        controlMin: 5,
      });
      expect(samples.length).toBeGreaterThanOrEqual(20);

      const { model, results, raw } = await callSemanticEnrichLive(samples);
      const review = autoReviewLiveEval(samples, results);
      const hallucinationCount = review.filter((r) => r.hallucination).length;
      const invalidSchemaCount = review.filter((r) => r.invalidSchema).length;
      const controls = review.filter((r) => !r.sample.gateNeedsEnrichment);

      const report = {
        model,
        sampleCount: samples.length,
        needsEnrichmentCount: samples.filter((s) => s.gateNeedsEnrichment).length,
        sufficientControlCount: samples.filter((s) => !s.gateNeedsEnrichment).length,
        hallucinationCount,
        invalidSchemaCount,
        controls: controls.map((c) => ({
          rawName: c.sample.rawName,
          localCategory: c.sample.localCategory,
          aiCategory: c.ai?.category ?? null,
          aiBrand: c.ai?.brand ?? null,
          aiCanonicalName: c.ai?.canonicalName ?? null,
          notes: c.notes,
        })),
        review,
        rawMeta: {
          success: (raw as any)?.success ?? null,
          modelFromEdge: model,
        },
      };
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            model,
            sampleCount: samples.length,
            hallucinationCount,
            invalidSchemaCount,
            sufficientControlCount: report.sufficientControlCount,
          },
          null,
          2
        )
      );

      expect(results.length).toBeGreaterThan(0);
      expect(model == null || /gemini/i.test(String(model))).toBe(true);
    },
    120_000
  );
});
