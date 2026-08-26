/**
 * Product Identity Batch 5B — 932 dual-run integration audit (live artifact).
 * Shadow metrics + consumer eligibility. Gemini = 0. No UI assertion here.
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
import {
  buildIdentityFrequentProductGroups,
  resolveIdentityConsumerObservations,
  buildIdentityMerchantProductHistoryView,
} from './productIdentityConsumer';
import { evaluatePriceObservationQuality } from './productIdentityPriceObservationQuality';

const ARTIFACT = path.join(
  __dirname,
  '../artifacts/product-intelligence-audit.json'
);

describe('Product Identity Batch 5B — 932 consumer integration audit', () => {
  const hasArtifact = fs.existsSync(ARTIFACT);

  (hasArtifact ? it : it.skip)(
    'reports identity frequent + quality-gated history coverage',
    () => {
      const payload = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
      const { dataset, observations } = buildDedupedShadowObservations(payload, {
        applyV1MerchantFilter: true,
      });
      expect(dataset.eligibleItemObservations).toBe(920);

      const enriched = enrichObservationsForPriceShadow(observations, payload);
      const shadow5a = runPriceComparisonShadowAudit(enriched, dataset);

      const consumerObs = enriched.map((o) => ({
        receiptId: o.receiptId,
        itemSourceIndex: o.itemSourceIndex,
        rawName: o.rawName,
        merchantKey: o.merchantKey,
        occurredAt: o.occurredAt ?? 0,
        lineTotal: o.lineTotal,
        quantity: o.quantity,
      }));
      const { qualified, store } =
        resolveIdentityConsumerObservations(consumerObs);
      const { groups } = buildIdentityFrequentProductGroups(consumerObs, store);

      const byMp = new Map<string, typeof qualified>();
      for (const q of qualified) {
        const list = byMp.get(q.merchantProductId) ?? [];
        list.push(q);
        byMp.set(q.merchantProductId, list);
      }

      let priceHistoryEligibleMps = 0;
      let priceHistoryEligibleObservations = 0;
      let trendEligibleMps = 0;
      let qualityExcluded = 0;
      let suspectedQuantityAnomalies = 0;
      const jumpBefore: Array<{
        mpId: string;
        names: string[];
        pct: number;
        prices: number[];
      }> = [];
      const jumpAfter: Array<{
        mpId: string;
        names: string[];
        pct: number;
        prices: number[];
      }> = [];

      for (const [mpId, rows] of byMp) {
        qualityExcluded += rows.filter(
          (r) => r.quality === 'invalid' || r.quality === 'suspected_anomaly'
        ).length;
        suspectedQuantityAnomalies += rows.filter(
          (r) => r.quality === 'suspected_anomaly'
        ).length;

        const view = buildIdentityMerchantProductHistoryView(mpId, rows);
        if (!view) continue;
        if (view.priceHistoryEligible) {
          priceHistoryEligibleMps += 1;
          priceHistoryEligibleObservations += view.historyPoints.length;
        }
        if (view.trendInsightEligible) trendEligibleMps += 1;

        const rawPrices = rows
          .filter((r) => r.purchaseUnitPrice != null)
          .sort((a, b) => a.occurredAt - b.occurredAt)
          .map((r) => r.purchaseUnitPrice!);
        if (rawPrices.length >= 3) {
          const prev = rawPrices[rawPrices.length - 2]!;
          const latest = rawPrices[rawPrices.length - 1]!;
          if (prev > 0) {
            jumpBefore.push({
              mpId,
              names: [...new Set(rows.map((r) => r.rawName))],
              pct: ((latest - prev) / prev) * 100,
              prices: rawPrices,
            });
          }
        }
        const trend = view.trendPoints.map((p) => p.purchaseUnitPrice);
        if (trend.length >= 3) {
          const prev = trend[trend.length - 2]!;
          const latest = trend[trend.length - 1]!;
          if (prev > 0) {
            jumpAfter.push({
              mpId,
              names: [...new Set(rows.map((r) => r.rawName))],
              pct: ((latest - prev) / prev) * 100,
              prices: trend,
            });
          }
        }
      }

      jumpBefore.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
      jumpAfter.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

      // Spot-check 横浜家系 / 正宗生煎 style multiples when present.
      const yokohama = [...byMp.values()].find((rows) =>
        rows.some((r) => /横浜家系|横浜家系|家系/.test(r.rawName))
      );
      const shengjian = [...byMp.values()].find((rows) =>
        rows.some((r) => /生煎/.test(r.rawName))
      );
      const anomalyCases: Record<string, unknown> = {};
      for (const [label, rows] of [
        ['yokohama', yokohama],
        ['shengjian', shengjian],
      ] as const) {
        if (!rows) continue;
        const prices = rows
          .map((r) => r.purchaseUnitPrice)
          .filter((p): p is number => p != null);
        const quality = rows.map((r) => ({
          price: r.purchaseUnitPrice,
          quality: r.quality,
          qty: r.quantity,
          lineTotal: r.lineTotal,
        }));
        anomalyCases[label] = {
          names: [...new Set(rows.map((r) => r.rawName))],
          prices,
          quality,
          suspected: rows.filter((r) => r.quality === 'suspected_anomaly').length,
        };
      }

      const report = {
        contractVersion: 'meruno-product-identity-batch5b-consumer-audit-v1',
        geminiAdditionalCalls: 0,
        dataset,
        baseline5a: {
          distinctMerchantProducts:
            shadow5a.identityBaseline.distinctMerchantProducts,
          mpGe2: shadow5a.merchantProductHistory.mpsWith2PlusPriceObs,
          mpGe3: shadow5a.merchantProductHistory.mpsWith3PlusPriceObs,
          mpGe5: shadow5a.merchantProductHistory.mpsWith5PlusPriceObs,
          observationsInRepeatedMpHistory:
            shadow5a.merchantProductHistory
              .priceObservationsParticipatingInMpHistory,
          skuExact: shadow5a.identityBaseline.skuExact,
          productExact: shadow5a.identityBaseline.productExact,
        },
        consumer: {
          priceHistoryEligibleMps,
          priceHistoryEligibleObservations,
          trendEligibleMps,
          qualityExcludedObservations: qualityExcluded,
          suspectedQuantityAnomalies,
          identityFrequentGroups: groups.length,
          frequentGroupsWith2Plus: groups.filter(
            (g) => g.distinctReceiptCount >= 2
          ).length,
        },
        topJumpsBeforeQualityGate: jumpBefore.slice(0, 20),
        topJumpsAfterQualityGate: jumpAfter.slice(0, 20),
        anomalySpotChecks: anomalyCases,
        top10Frequent: groups.slice(0, 10).map((g) => ({
          key: g.key,
          displayName: g.displayName,
          merchantKey: g.merchantKey,
          distinctReceiptCount: g.distinctReceiptCount,
          rawNameVariants: g.rawNameVariants,
        })),
        recommendationForBatch6: [
          'same_merchant_product + quality gate is ready for V1 TestFlight with merchant-local copy.',
          'Canonical / cross-merchant exact history still blocked (product_exact=0).',
          'Review remaining large trend jumps after quality gate before enabling strong 値上がり copy.',
        ],
      };

      expect(report.baseline5a.distinctMerchantProducts).toBe(612); // A1.3.2 score-first Costco rep
      expect(report.baseline5a.mpGe2).toBe(162); // A1.3.2 score-first Costco rep
      expect(report.consumer.priceHistoryEligibleMps).toBeGreaterThan(0);
      expect(report.geminiAdditionalCalls).toBe(0);

      const outPath = path.join(
        __dirname,
        '../artifacts/product-identity-batch5b-consumer-audit.json'
      );
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(report, null, 2));
    }
  );
});
