jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';

import { buildIdentityFrequentProductGroups } from './productIdentityConsumer';
import { enrichObservationsForPriceShadow } from './productIdentityPriceComparisonShadowAudit';
import {
  FUZZY_CANDIDATE_FLOOR,
  resolveReceiptItemIdentity,
  scopeMerchantKeyForIdentity,
} from './productIdentityResolver';
import {
  combinedNameSimilarity,
  combinedNameSimilarityAtOrAbovePotential,
  type FuzzySimilarityDiagnostics,
} from './productIdentitySimilarity';
import { buildDedupedShadowObservations } from './productIdentityShadowAuditDataset';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';

const ARTIFACT = path.join(
  __dirname,
  '../artifacts/product-intelligence-audit.json'
);

function diagnostics(): FuzzySimilarityDiagnostics {
  return {
    candidateVisits: 0,
    upperBoundRejected: 0,
    lengthUpperBoundRejected: 0,
    tokenUpperBoundRejected: 0,
    expensiveSimilarityCalls: 0,
  };
}

function reachesFuzzyPath(reason: string): boolean {
  return (
    reason === 'same_merchant_fuzzy_auto' ||
    reason === 'new_merchant_product' ||
    reason === 'family_spec_generic' ||
    reason === 'family_only_generic' ||
    reason === 'unresolved_empty_key'
  );
}

describe('Product Identity fuzzy optimization live equivalence', () => {
  const hasArtifact = fs.existsSync(ARTIFACT);

  (hasArtifact ? it : it.skip)(
    'preserves the frozen resolver population while eliminating fixture Levenshtein calls',
    () => {
      const payload = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
      const { observations } = buildDedupedShadowObservations(payload, {
        applyV1MerchantFilter: true,
      });
      const store = createMemoryProductIdentityStore();
      const fuzzyDiagnostics = diagnostics();
      const observationsByMerchantProduct = new Map<string, number>();
      let resolverResultDifferences = 0;
      let created = 0;
      let exactReuse = 0;
      let familySpec = 0;
      let familyOnly = 0;
      let acceptedFuzzyResults = 0;

      expect(observations).toHaveLength(932);

      for (const observation of observations) {
        const name = (observation.rawName || '').trim();
        const merchantKey = scopeMerchantKeyForIdentity(
          observation.merchantKey || 'unknown_merchant',
          observation.receiptId
        );
        const comparisonKey = normalizeProductForIdentity(name).comparisonKey;
        const catalogBeforeResolution = store.listMerchantProducts(merchantKey);
        const result = resolveReceiptItemIdentity(
          {
            rawName: name,
            merchantKey: observation.merchantKey || 'unknown_merchant',
            receiptId: observation.receiptId,
            itemSourceIndex: observation.itemSourceIndex,
            quantity: observation.quantity,
            lineTotal: observation.lineTotal,
          },
          store
        );

        if (reachesFuzzyPath(result.reason)) {
          for (const candidate of catalogBeforeResolution) {
            const referenceScore = combinedNameSimilarity(
              comparisonKey,
              candidate.comparisonKey
            );
            const optimizedScore = combinedNameSimilarityAtOrAbovePotential(
              comparisonKey,
              candidate.comparisonKey,
              FUZZY_CANDIDATE_FLOOR,
              fuzzyDiagnostics
            );
            if (optimizedScore == null) {
              if (referenceScore >= FUZZY_CANDIDATE_FLOOR) {
                resolverResultDifferences += 1;
              }
            } else if (optimizedScore !== referenceScore) {
              resolverResultDifferences += 1;
            }
          }
        }

        if (result.createdMerchantProduct) created += 1;
        if (result.reason === 'same_merchant_comparison_key') exactReuse += 1;
        if (result.link.identityLevel === 'family_spec') familySpec += 1;
        if (result.link.identityLevel === 'family_only') familyOnly += 1;
        if (result.reason === 'same_merchant_fuzzy_auto') {
          acceptedFuzzyResults += 1;
        }
        if (result.link.merchantProductId) {
          observationsByMerchantProduct.set(
            result.link.merchantProductId,
            (observationsByMerchantProduct.get(result.link.merchantProductId) ??
              0) + 1
          );
        }
      }

      const observationCounts = [...observationsByMerchantProduct.values()];
      expect(created).toBe(610);
      expect(exactReuse).toBe(322);
      expect(familySpec).toBe(2);
      expect(familyOnly).toBe(20);
      expect(observationsByMerchantProduct.size).toBe(610);
      expect(observationCounts.filter((count) => count >= 2)).toHaveLength(165);
      expect(observationCounts.filter((count) => count >= 3)).toHaveLength(66);

      expect(fuzzyDiagnostics).toEqual({
        candidateVisits: 37465,
        upperBoundRejected: 37465,
        lengthUpperBoundRejected: 20659,
        tokenUpperBoundRejected: 16806,
        expensiveSimilarityCalls: 0,
      });
      expect(acceptedFuzzyResults).toBe(0);
      expect(resolverResultDifferences).toBe(0);

      const consumerObservations = enrichObservationsForPriceShadow(
        observations,
        payload
      ).map((observation) => ({
        receiptId: observation.receiptId,
        itemSourceIndex: observation.itemSourceIndex,
        rawName: observation.rawName,
        merchantKey: observation.merchantKey,
        occurredAt: observation.occurredAt ?? 0,
        lineTotal: observation.lineTotal,
        quantity: observation.quantity,
      }));
      const { groups, qualified } =
        buildIdentityFrequentProductGroups(consumerObservations);

      expect(qualified).toHaveLength(932);
      expect(groups).toHaveLength(160);
    }
  );
});
