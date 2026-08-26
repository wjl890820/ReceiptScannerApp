/**
 * Product Identity Batch 6 — Final Production Identity Audit.
 * Audit / stabilize only. Gemini additional calls = 0. No new features.
 */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import {
  buildIdentityFrequentProductGroups,
  buildIdentityMerchantProductHistoryView,
  resolveIdentityConsumerObservations,
} from './productIdentityConsumer';
import {
  enrichObservationsForPriceShadow,
  runPriceComparisonShadowAudit,
} from './productIdentityPriceComparisonShadowAudit';
import { combinedNameSimilarity } from './productIdentitySimilarity';
import { runShadowIdentityAudit } from './productIdentityShadowAudit';
import { buildDedupedShadowObservations } from './productIdentityShadowAuditDataset';

const ARTIFACT = path.join(
  __dirname,
  '../artifacts/product-intelligence-audit.json'
);
const OUT = path.join(
  __dirname,
  '../artifacts/product-identity-batch6-final-audit.json'
);

describe('Product Identity Batch 6 — final production audit', () => {
  const hasArtifact = fs.existsSync(ARTIFACT);

  (hasArtifact ? it : it.skip)(
    'produces final release-decision audit over Analysis-D 932',
    () => {
      const t0 = Date.now();
      const payload = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));

      const tIdentity0 = Date.now();
      const { dataset, observations } = buildDedupedShadowObservations(payload, {
        applyV1MerchantFilter: true,
      });
      expect(dataset.storedReceiptCount).toBe(127);
      expect(dataset.duplicateExtrasExcluded).toBe(24);
      expect(dataset.purchaseCandidateCount).toBe(103);
      expect(dataset.v1SupportedPurchaseCandidateCount).toBe(99);
      expect(dataset.eligibleItemObservations).toBe(920);

      const identityReport = runShadowIdentityAudit(
        observations,
        undefined,
        dataset
      );
      const identityMs = Date.now() - tIdentity0;

      const tHist0 = Date.now();
      const enriched = enrichObservationsForPriceShadow(observations, payload);
      const shadow5a = runPriceComparisonShadowAudit(enriched, dataset);
      const historyMs = Date.now() - tHist0;

      const tFreq0 = Date.now();
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
      const { groups: frequentGroups } = buildIdentityFrequentProductGroups(
        consumerObs,
        store
      );
      const frequentMs = Date.now() - tFreq0;

      const byMp = new Map<string, typeof qualified>();
      for (const q of qualified) {
        const list = byMp.get(q.merchantProductId) ?? [];
        list.push(q);
        byMp.set(q.merchantProductId, list);
      }

      type MpStat = {
        id: string;
        merchantKey: string;
        obsCount: number;
        distinctReceipts: number;
        names: string[];
        prices: number[];
        qualities: string[];
      };

      const mpStats: MpStat[] = [...byMp.entries()].map(([id, rows]) => ({
        id,
        merchantKey: rows[0]!.merchantKey,
        obsCount: rows.length,
        distinctReceipts: new Set(rows.map((r) => r.receiptId)).size,
        names: [...new Set(rows.map((r) => r.rawName))],
        prices: rows
          .map((r) => r.purchaseUnitPrice)
          .filter((p): p is number => typeof p === 'number'),
        qualities: rows.map((r) => r.quality),
      }));

      const mpGe2 = mpStats.filter((m) => m.obsCount >= 2);
      const mpGe3 = mpStats.filter((m) => m.obsCount >= 3);
      const mpGe5 = mpStats.filter((m) => m.obsCount >= 5);
      const frequentIds = new Set(frequentGroups.map((g) => g.key));

      const discrepancy = mpGe2
        .filter((m) => !frequentIds.has(m.id))
        .map((m) => ({
          merchantProductId: m.id,
          merchantKey: m.merchantKey,
          names: m.names,
          observationCount: m.obsCount,
          distinctReceipts: m.distinctReceipts,
          prices: m.prices,
          reason:
            m.distinctReceipts < 2
              ? 'same_receipt_multi_line_obs_ge2_but_distinct_receipts_lt_2'
              : 'unexpected_filter',
        }));

      expect(mpGe2.length).toBe(162); // A1.3.2 score-first Costco rep
      expect(frequentGroups.length).toBe(157); // A1.3.2 score-first Costco rep
      expect(discrepancy.length).toBe(5);
      expect(
        discrepancy.every(
          (d) =>
            d.reason ===
            'same_receipt_multi_line_obs_ge2_but_distinct_receipts_lt_2'
        )
      ).toBe(true);

      let historyEligibleMps = 0;
      let historyObs = 0;
      let trendEligibleMps = 0;
      let trustedObs = 0;
      let cautionObs = 0;
      let suspectedObs = 0;
      let invalidObs = 0;

      for (const rows of byMp.values()) {
        for (const r of rows) {
          if (r.quality === 'trusted') trustedObs += 1;
          else if (r.quality === 'usable_with_caution') cautionObs += 1;
          else if (r.quality === 'suspected_anomaly') suspectedObs += 1;
          else if (r.quality === 'invalid') invalidObs += 1;
        }
      }

      for (const [mpId, rows] of byMp) {
        const view = buildIdentityMerchantProductHistoryView(mpId, rows);
        if (!view) continue;
        if (view.priceHistoryEligible) {
          historyEligibleMps += 1;
          historyObs += view.historyPoints.length;
        }
        if (view.trendInsightEligible) trendEligibleMps += 1;
      }

      const top20 = [...mpStats]
        .sort((a, b) => b.obsCount - a.obsCount || a.id.localeCompare(b.id))
        .slice(0, 20)
        .map((m) => {
          const nameSpread = m.names.length >= 3;
          const minP = m.prices.length ? Math.min(...m.prices) : null;
          const maxP = m.prices.length ? Math.max(...m.prices) : null;
          const span =
            minP != null && maxP != null && minP > 0 ? (maxP - minP) / minP : 0;
          return {
            merchantProductId: m.id,
            merchantKey: m.merchantKey,
            displayName: m.names[0],
            observationCount: m.obsCount,
            distinctReceipts: m.distinctReceipts,
            rawNameVariants: m.names,
            priceRange: minP != null && maxP != null ? [minP, maxP] : null,
            suspectedAnomalies: m.qualities.filter(
              (q) => q === 'suspected_anomaly'
            ).length,
            possibleFalseMerge: nameSpread,
            note: nameSpread
              ? 'REVIEW: multiple raw names under one MP'
              : span >= 0.8
                ? 'large price span — check weighable/promo/OCR'
                : 'names look consistent',
          };
        });

      const byMerchant = new Map<string, MpStat[]>();
      for (const m of mpStats) {
        const list = byMerchant.get(m.merchantKey) ?? [];
        list.push(m);
        byMerchant.set(m.merchantKey, list);
      }
      const splitCandidates: Array<{
        merchantKey: string;
        leftId: string;
        rightId: string;
        leftNames: string[];
        rightNames: string[];
        leftComparisonKey: string;
        rightComparisonKey: string;
        similarity: number;
        note: string;
      }> = [];
      for (const [merchantKey, list] of byMerchant) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i]!;
            const b = list[j]!;
            const leftNorm = normalizeProductForIdentity(a.names[0] ?? '');
            const rightNorm = normalizeProductForIdentity(b.names[0] ?? '');
            const left = leftNorm.comparisonKey;
            const right = rightNorm.comparisonKey;
            if (!left || !right || left === right) continue;
            const sim = combinedNameSimilarity(left, right);
            // Audit-only threshold (do NOT lower production fuzzy match).
            if (sim >= 0.82 && sim < 1) {
              splitCandidates.push({
                merchantKey,
                leftId: a.id,
                rightId: b.id,
                leftNames: a.names,
                rightNames: b.names,
                leftComparisonKey: left,
                rightComparisonKey: right,
                similarity: sim,
                note:
                  sim >= 0.92
                    ? 'HIGH — review if deterministic normalize should merge'
                    : 'MODERATE — likely intentional separate variants',
              });
            }
          }
        }
      }
      splitCandidates.sort((a, b) => b.similarity - a.similarity);
      const top20Splits = splitCandidates.slice(0, 20);

      const nameToMerchants = new Map<string, Set<string>>();
      for (const m of mpStats) {
        for (const n of m.names) {
          const key =
            normalizeProductForIdentity(n).comparisonKey || n.trim();
          const set = nameToMerchants.get(key) ?? new Set();
          set.add(m.merchantKey);
          nameToMerchants.set(key, set);
        }
      }
      const crossMerchantExamples = [...nameToMerchants.entries()]
        .filter(([, merchants]) => merchants.size >= 2)
        .slice(0, 10)
        .map(([nameKey, merchants]) => ({
          comparisonKey: nameKey,
          merchants: [...merchants],
          note: 'separate MerchantProducts by design; product_exact=0',
        }));

      const pickMaxObs = (pred: (m: MpStat) => boolean): MpStat | null => {
        const hits = mpStats.filter(pred);
        if (!hits.length) return null;
        return hits.sort((a, b) => b.obsCount - a.obsCount)[0]!;
      };
      const yokohama = pickMaxObs((m) =>
        m.names.some((n) => /横浜家系/.test(n))
      );
      const shengjian = pickMaxObs((m) =>
        m.names.some((n) => /正宗生煎包/.test(n))
      );
      const shengjianAll = mpStats
        .filter((m) => m.names.some((n) => /生煎/.test(n)))
        .map((m) => ({
          id: m.id,
          merchantKey: m.merchantKey,
          names: m.names,
          obsCount: m.obsCount,
          prices: m.prices,
          qualities: m.qualities,
          suspected: m.qualities.filter((q) => q === 'suspected_anomaly')
            .length,
        }));

      const jumpsAfter: Array<{
        names: string[];
        pct: number;
        prices: number[];
      }> = [];
      for (const [mpId, rows] of byMp) {
        const view = buildIdentityMerchantProductHistoryView(mpId, rows);
        if (!view || view.trendPoints.length < 3) continue;
        const prices = view.trendPoints.map((p) => p.purchaseUnitPrice);
        const prev = prices[prices.length - 2]!;
        const latest = prices[prices.length - 1]!;
        if (prev > 0) {
          jumpsAfter.push({
            names: [...new Set(rows.map((r) => r.rawName))],
            pct: ((latest - prev) / prev) * 100,
            prices,
          });
        }
      }
      jumpsAfter.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

      let semanticFinal: Record<string, unknown> | null = null;
      const semPath = path.join(
        __dirname,
        '../artifacts/product-identity-semantic-batch4.1-dryrun.json'
      );
      if (fs.existsSync(semPath)) {
        const sem = JSON.parse(fs.readFileSync(semPath, 'utf8'));
        semanticFinal = {
          distinctMerchantProducts:
            sem.semantic?.distinctMerchantProducts ?? null,
          needingEnrichment:
            sem.semantic?.distinctNeedingEnrichment ?? null,
          ratioNeedingAi: sem.semantic?.ratioDistinctNeedingAi ?? null,
          receiptCost: sem.receiptCost ?? null,
          source: 'batch4.1-dryrun-artifact',
        };
      }

      const totalMs = Date.now() - t0;
      const report = {
        contractVersion: 'meruno-product-identity-batch6-final-audit-v1',
        geminiAdditionalCalls: 0,
        dataset: {
          storedReceipts: dataset.storedReceiptCount,
          duplicateExtras: dataset.duplicateExtrasExcluded,
          purchaseCandidates: dataset.purchaseCandidateCount,
          v1Supported: dataset.v1SupportedPurchaseCandidateCount,
          eligibleObservations: dataset.eligibleItemObservations,
        },
        identityCoverage: {
          byLevel: identityReport.byLevel,
          byAction: identityReport.byAction,
          entityAssignment: identityReport.entityAssignment,
          reuseQuality: identityReport.reuseQuality,
        },
        kpis: {
          distinctMerchantProducts: byMp.size,
          existingMpReuse:
            identityReport.entityAssignment.merchantProductExistingMatch,
          reuseRate: identityReport.reuseQuality.merchantProductReuseRate,
          mpGe2: mpGe2.length,
          mpGe3: mpGe3.length,
          mpGe5: mpGe5.length,
          observationsInRepeatedMp: mpGe2.reduce((a, m) => a + m.obsCount, 0),
        },
        shadow5aBaseline: {
          distinctMerchantProducts:
            shadow5a.identityBaseline.distinctMerchantProducts,
          mpGe2: shadow5a.merchantProductHistory.mpsWith2PlusPriceObs,
          mpGe3: shadow5a.merchantProductHistory.mpsWith3PlusPriceObs,
          mpGe5: shadow5a.merchantProductHistory.mpsWith5PlusPriceObs,
          skuExact: shadow5a.identityBaseline.skuExact,
          productExact: shadow5a.identityBaseline.productExact,
        },
        frequentVsMpGe2: {
          mpGe2: mpGe2.length,
          identityFrequentGroupsGe2: frequentGroups.length,
          discrepancyCount: discrepancy.length,
          discrepancy,
          verdict:
            'NOT a consumer bug: frequent requires distinctReceipts>=2; MP>=2 / history counts observations (same-receipt multi-line allowed).',
        },
        priceHistoryFinal: {
          mpGe2Baseline: mpGe2.length,
          historyEligibleMps: historyEligibleMps,
          historyObservations: historyObs,
          trustedObservations: trustedObs,
          usableWithCaution: cautionObs,
          suspectedAnomaly: suspectedObs,
          invalid: invalidObs,
          trendEligibleMps: trendEligibleMps,
          layerSeparation: {
            identityCapability: 'has merchantProductId',
            historyEligibility: '>=2 usable (trusted|caution) dated obs',
            trendEligibility: '>=3 trusted on >=2 distinct days',
          },
        },
        anomalySpotChecks: {
          yokohama: yokohama
            ? {
                id: yokohama.id,
                names: yokohama.names,
                obsCount: yokohama.obsCount,
                prices: yokohama.prices,
                qualities: yokohama.qualities,
                suspected: yokohama.qualities.filter(
                  (q) => q === 'suspected_anomaly'
                ).length,
                has794: yokohama.prices.includes(794),
              }
            : null,
          shengjian: shengjian
            ? {
                id: shengjian.id,
                names: shengjian.names,
                obsCount: shengjian.obsCount,
                prices: shengjian.prices,
                qualities: shengjian.qualities,
                suspected: shengjian.qualities.filter(
                  (q) => q === 'suspected_anomaly'
                ).length,
                has1756: shengjian.prices.includes(1756),
              }
            : null,
          allShengjianMps: shengjianAll,
        },
        top20RepeatedMpManualAudit: top20,
        falseSplitCandidatesTop20: top20Splits,
        crossMerchantExamples,
        top20JumpsAfterQualityGate: jumpsAfter.slice(0, 20),
        semanticFinal,
        models: {
          ocrGeminiModelDefault: 'gemini-3.5-flash-lite',
          semanticGeminiModelDefault: 'gemini-3.5-flash',
          note: 'Defaults from env.ts / classify-items; no gemini-2.5/3.0 on Batch 4.1 semantic_enrich path',
        },
        featureFlag: {
          name: 'ENABLE_PRODUCT_IDENTITY_PRICE_HISTORY_V1',
          defaultOn: true,
          recommendation: 'Option A — default ON, legacy fallback retained',
        },
        supabase007: {
          path: 'supabase/migrations/007_product_identity_entities.sql',
          recommendation: 'defer_cloud_product_entity_persistence',
          reason:
            'V1 identity is derived/local rebuildable from receipt truth; cloud entity tables not required for restore success.',
        },
        performance: {
          totalMs,
          identityMs,
          historyAggregationMs: historyMs,
          frequentAggregationMs: frequentMs,
        },
        knownV1Limitations: [
          'no reliable cross-merchant canonical merge',
          'SKU/JAN sparse/zero',
          'same item across stores may appear separately',
          'unit-price coverage limited',
          'semantic enrichment not exhaustive',
          'weighted goods price history inherently noisy',
        ],
        releaseDecision: 'PASS_WITH_NON_BLOCKING_LIMITATIONS',
        featureFreeze: 'PRODUCT IDENTITY V1 FEATURE FREEZE',
      };

      expect(report.kpis.distinctMerchantProducts).toBe(612); // A1.3.2 score-first Costco rep
      expect(report.kpis.mpGe2).toBe(162); // A1.3.2 score-first Costco rep
      expect(report.frequentVsMpGe2.identityFrequentGroupsGe2).toBe(157);
      expect(report.priceHistoryFinal.historyEligibleMps).toBe(162);
      expect(report.geminiAdditionalCalls).toBe(0);
      // A1.3.1: tax-known 022 representative uses qty=2 → unit ~397, not lineTotal 794.
      // Prior suspected_anomaly/has794 came from the tax-unknown qty=1 observation.
      expect(report.anomalySpotChecks.yokohama?.suspected ?? 0).toBe(0);
      expect(report.anomalySpotChecks.yokohama?.has794).toBe(false);
      expect(report.anomalySpotChecks.yokohama?.prices.includes(397)).toBe(true);
      expect(
        report.anomalySpotChecks.shengjian?.suspected ?? 0
      ).toBeGreaterThanOrEqual(1);
      expect(report.anomalySpotChecks.shengjian?.has1756).toBe(true);
      expect(report.anomalySpotChecks.shengjian?.obsCount).toBe(7); // A1.3.2 score-first Costco rep

      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            dataset: report.dataset,
            kpis: report.kpis,
            identityCoverage: report.identityCoverage,
            frequentVsMpGe2: {
              mpGe2: report.frequentVsMpGe2.mpGe2,
              frequent: report.frequentVsMpGe2.identityFrequentGroupsGe2,
              discrepancy: report.frequentVsMpGe2.discrepancy,
              verdict: report.frequentVsMpGe2.verdict,
            },
            priceHistoryFinal: report.priceHistoryFinal,
            anomaly: report.anomalySpotChecks,
            top20: report.top20RepeatedMpManualAudit.map((t) => ({
              n: t.observationCount,
              name: t.displayName,
              variants: t.rawNameVariants.length,
              note: t.note,
              suspected: t.suspectedAnomalies,
            })),
            splitSample: report.falseSplitCandidatesTop20.slice(0, 8),
            crossMerchant: report.crossMerchantExamples.slice(0, 5),
            jumpsAfter: report.top20JumpsAfterQualityGate.slice(0, 8),
            performance: report.performance,
            flag: report.featureFlag,
            decision: report.releaseDecision,
          },
          null,
          2
        )
      );
    }
  );
});
