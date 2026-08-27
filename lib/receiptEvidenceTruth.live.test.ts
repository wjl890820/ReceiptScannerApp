/**
 * A1.4A — optional live Ground Truth shadow audit against 127-receipt artifact.
 * Production baseline must remain stored=127, extras=24, analytics=103.
 * Does NOT write artifact files.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { buildGroundTruthShadowAudit } from './receiptEvidenceTruth';
import { receiptRowFromIntelligenceExport } from './productIdentityShadowAuditDataset';

const ARTIFACT = path.join(
  __dirname,
  '../artifacts/product-intelligence-audit.json'
);

describe('A1.4A Ground Truth shadow audit — live (optional)', () => {
  const hasArtifact = fs.existsSync(ARTIFACT);

  (hasArtifact ? it : it.skip)(
    'preserves production baseline and exposes GT shadow evidence outcomes',
    () => {
      const payload = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8')) as {
        receipts?: Array<Record<string, unknown>>;
      };
      const receipts = (payload.receipts ?? []).map(
        receiptRowFromIntelligenceExport
      );

      const selection = selectAnalyticsReceipts(receipts);
      expect(selection.storedReceipts).toHaveLength(127);
      expect(selection.highConfidenceDuplicateExtras).toBe(24);
      expect(selection.analyticsReceipts).toHaveLength(103);

      const report = buildGroundTruthShadowAudit(receipts);
      expect(report.productionBaseline).toEqual({
        highConfidenceDuplicateExtras: 24,
        analyticsPurchaseCandidateCount: 103,
      });
      expect(report.storedReceiptCount).toBe(127);

      const gt002 = report.cases.find((c) => c.caseId === 'GT-002')!;
      const gt017 = report.cases.find((c) => c.caseId === 'GT-017')!;
      const gt019 = report.cases.find((c) => c.caseId === 'GT-019')!;
      const gt020 = report.cases.find((c) => c.caseId === 'GT-020')!;

      expect(gt002.sourceReceiptIds).toHaveLength(6);
      expect(gt002.productionCandidateCount).toBe(3);
      expect(gt002.productionCandidateIds).toHaveLength(3);

      expect(gt002.shadowDuplicateCandidateGroups).toHaveLength(0);
      expect(
        gt002.shadowDuplicateCandidateGroups.some(
          (g) => g.path === 'SHADOW_DATE_YEAR_CONFLICT_RESCAN' as never
        )
      ).toBe(false);

      expect(gt002.dateYearConflictDiagnostic).not.toBeNull();
      expect(gt002.dateYearConflictDiagnostic!.shadowDuplicateAuthorized).toBe(false);
      expect(gt002.dateYearConflictDiagnostic!.caseSourceReceiptIds.sort()).toEqual(
        gt002.sourceReceiptIds.sort()
      );
      expect(gt002.dateYearConflictDiagnostic!.conflictingYears.length).toBeGreaterThan(1);
      expect(
        gt002.dateYearConflictDiagnostic!.reasonCodes
      ).toContain('diagnostic_only_not_duplicate_authorization');
      expect(
        gt002.dateYearConflictDiagnostic!.reasonCodes
      ).toContain('no_year_correction_applied');
      expect(
        gt002.dateYearConflictDiagnostic!.reasonCodes
      ).toContain('per_source_receipt_year_attribution');
      expect(
        Object.values(gt002.dateYearConflictDiagnostic!.observedYearsByReceiptId).some(
          (y) => y === 2025
        )
      ).toBe(false);

      const years = gt002.dateYearConflictDiagnostic!.observedYearsByReceiptId;
      expect(Object.keys(years).sort()).toEqual(gt002.sourceReceiptIds.sort());
      expect(years['C_aMA69ijcqNLhGI76Y5Q']).toBe(2023);
      expect(years['4a1-xfRs0jLc9QREdaKcb']).toBe(2020);
      expect(years['ElhqdUr9SU-xD-1s5JbS3']).toBe(2026);
      expect(years['NEHGZCkqd8MiBCyKO-fWd']).toBe(2023);
      expect(years['2bDvMWs3dkCKagyrYWyxA']).toBe(2023);
      expect(years['n6_vGM5c8X255Psyiup4k']).toBe(2023);
      expect(new Set(Object.values(years).filter((y) => y != null)).size).toBeGreaterThan(1);

      expect(
        gt002.evidence.some((e) => e.includes('GT-002_analysis_year'))
      ).toBe(true);
      expect(
        gt002.evidence.some((e) => e.includes('C_aMA69ijcqNLhGI76Y5Q'))
      ).toBe(true);

      expect(gt017.productionCandidateCount).toBe(2);
      expect(gt017.sourceReceiptIds.sort()).toEqual(
        ['OzH_95aHPw9Claz4oXpJH', '_KWltUWmzEA2ubrHWh3zF'].sort()
      );
      expect(gt017.merchantMetadataVariantEvaluation).not.toBeNull();
      expect(gt017.merchantMetadataVariantEvaluation!.merchantCompatibility).toBe(
        'compatible_missing_store_hint'
      );

      if (
        gt017.merchantMetadataVariantEvaluation!.transactionAuthorization ===
        'insufficient_provenance'
      ) {
        expect(gt017.merchantMetadataVariantEvaluation!.shadowDuplicateAuthorized).toBe(
          false
        );
        expect(gt017.shadowDuplicateCandidateGroups).toHaveLength(0);
      }

      expect(gt019.productionCandidateCount).toBe(1);
      expect(gt019.shadowRepresentativeRecommendation).not.toBeNull();
      expect(
        gt019.shadowRepresentativeRecommendation!.productionRepresentativeReceiptId
      ).toBe('pbU0NavDejcsAEM7fGlMB');
      expect(
        gt019.shadowRepresentativeRecommendation!.shadowRecommendedRepresentativeReceiptId
      ).toBe('9Brk_HjDEvLeBD2i6c7Hb');

      expect(gt020.productionCandidateCount).toBe(1);
      expect(gt020.monetaryProvenanceNotes.length).toBeGreaterThan(0);
      expect(
        gt020.monetaryProvenanceNotes.some((n) =>
          n.includes('monetaryState=known_incoherent')
        )
      ).toBe(true);
      expect(
        gt020.monetaryProvenanceNotes.some((n) =>
          n.includes('discountOwnership=unresolved')
        )
      ).toBe(true);
    }
  );
});
