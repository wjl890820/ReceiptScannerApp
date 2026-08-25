jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { buildIdentityFrequentProductGroups } from './productIdentityConsumer';
import { enrichObservationsForPriceShadow } from './productIdentityPriceComparisonShadowAudit';
import {
  buildDedupedShadowObservations,
  receiptRowFromIntelligenceExport,
} from './productIdentityShadowAuditDataset';
import { runShadowIdentityAudit } from './productIdentityShadowAudit';
import { filterHomeIdentityProductRows } from './homeProgressiveExperience';
import { filterV1SupportedReceipts } from './merchantType';
import {
  beginHomeColdStartTiming,
  getActiveHomeColdStartTimingSnapshotForTests,
  resetHomeColdStartTimingForTests,
} from './homeColdStartTiming';

const ARTIFACT = path.join(
  __dirname,
  '../artifacts/product-intelligence-audit.json'
);

describe('Home Product Identity V1 population boundary', () => {
  const hasArtifact = fs.existsSync(ARTIFACT);

  (hasArtifact ? it : it.skip)(
    'excludes unsupported purchase rows while preserving frozen identity counts and order',
    () => {
      const payload = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
      const receipts = (payload.receipts ?? []).map(
        receiptRowFromIntelligenceExport
      );
      const selection = selectAnalyticsReceipts(receipts);
      const supportedReceipts = filterV1SupportedReceipts(
        selection.analyticsReceipts
      );
      const supportedReceiptIds = new Set(
        supportedReceipts.map((receipt) => receipt.id)
      );
      const broad = buildDedupedShadowObservations(payload, {
        applyV1MerchantFilter: false,
      });
      const supportedObservations = filterHomeIdentityProductRows(
        broad.observations,
        supportedReceiptIds
      );
      const expectedOrder = broad.observations.filter((observation) =>
        supportedReceiptIds.has(observation.receiptId)
      );
      const unsupportedObservations = broad.observations.filter(
        (observation) => !supportedReceiptIds.has(observation.receiptId)
      );

      expect(selection.storedReceipts).toHaveLength(127);
      expect(selection.highConfidenceDuplicateExtras).toBe(23);
      expect(selection.analyticsReceipts).toHaveLength(104);
      expect(supportedReceipts).toHaveLength(100);
      expect(broad.observations).toHaveLength(968);
      expect(supportedObservations).toHaveLength(932);
      expect(unsupportedObservations).toHaveLength(36);
      expect(
        new Set(unsupportedObservations.map((observation) => observation.receiptId))
          .size
      ).toBe(4);
      expect(supportedObservations).toEqual(expectedOrder);

      const shadow = runShadowIdentityAudit(supportedObservations);
      expect(shadow.entityAssignment.distinctMerchantProducts).toBe(610);
      expect(shadow.entityAssignment.merchantProductNewEntity).toBe(610);
      expect(shadow.reuseQuality.merchantProductsWith2PlusObservations).toBe(
        165
      );
      expect(shadow.reuseQuality.merchantProductsWith3PlusObservations).toBe(
        66
      );
      expect(shadow.byAction.existing_exact).toBe(322);
      expect(shadow.byLevel.family_spec).toBe(2);
      expect(shadow.byLevel.family_only).toBe(20);

      const consumerObservations = enrichObservationsForPriceShadow(
        supportedObservations,
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
      resetHomeColdStartTimingForTests();
      beginHomeColdStartTiming();
      const { groups, qualified } =
        buildIdentityFrequentProductGroups(consumerObservations);
      const timingPhases =
        getActiveHomeColdStartTimingSnapshotForTests()?.phases;

      expect(qualified).toHaveLength(932);
      expect(groups).toHaveLength(160);
      expect(timingPhases?.identityResolverObservationLoop?.counts).toMatchObject(
        {
          observationCount: 932,
          resolvedObservationCount: 932,
          createdMerchantProductCount: 610,
        }
      );
      expect(timingPhases?.identityNormalization?.counts).toEqual({
        normalizationCallCount: 932,
      });
      expect(timingPhases?.identityExactLookup?.counts).toMatchObject({
        exactLookupCount: 932,
        exactLookupHitCount: 322,
        exactLookupMissCount: 610,
        exactAcceptedMatchCount: 322,
      });
      expect(timingPhases?.identityMerchantProductUpsert?.counts).toEqual({
        merchantProductUpsertCount: 610,
        createdMerchantProductCount: 610,
      });
      expect(timingPhases?.identityLinkPersistence?.counts).toEqual({
        linkPersistenceCount: 932,
      });
      expect(timingPhases?.identityQualityQualification?.counts).toEqual({
        qualityEvaluationCount: 932,
      });
      expect(timingPhases?.identityQualityNormalization?.counts).toEqual({
        qualityNormalizationCallCount: 932,
      });
      expect(timingPhases?.frequentAggregation?.counts).toEqual({
        merchantProductCount: 610,
        frequentGroupCount: 160,
      });
      resetHomeColdStartTimingForTests();
    }
  );
});
