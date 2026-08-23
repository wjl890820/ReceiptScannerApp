/**
 * Optional live shadow audit against local export artifact (Batch 3.1).
 * Uses Analysis D high-confidence deduped purchase candidates + V1 filter.
 * Skips when artifact is absent. Never writes to receipt SoT / Supabase.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as path from 'path';

import { runDedupedShadowIdentityAudit } from './productIdentityShadowAuditDataset';

const ARTIFACT = path.join(
  __dirname,
  '../artifacts/product-intelligence-audit.json'
);

describe('Product Identity Batch 3.1 — live deduped shadow audit (optional)', () => {
  const hasArtifact = fs.existsSync(ARTIFACT);

  (hasArtifact ? it : it.skip)(
    'runs read-only resolver over Analysis-D deduped V1 observations',
    () => {
      const payload = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8')) as {
        receipts?: Array<Record<string, unknown>>;
        receiptItems?: Array<{
          receipt_id: string;
          source_index?: number;
          name?: string | null;
          raw_name?: string | null;
          quantity?: number | null;
          lineTotal?: number | null;
          line_total?: number | null;
        }>;
      };

      const started = Date.now();
      const report = runDedupedShadowIdentityAudit(payload, {
        applyV1MerchantFilter: true,
      });
      const elapsedMs = Date.now() - started;

      expect(report.dataset.eligibleItemObservations).toBeGreaterThan(0);
      expect(report.dataset.storedReceiptCount).toBeGreaterThan(0);
      expect(report.geminiAdditionalCalls).toBe(0);
      expect(elapsedMs).toBeLessThan(60_000);

      const outPath = path.join(
        __dirname,
        '../artifacts/product-identity-shadow-batch3.1.json'
      );
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(
        outPath,
        JSON.stringify({ ...report, elapsedMs }, null, 2),
        'utf8'
      );

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            dataset: report.dataset,
            byLevel: report.byLevel,
            byAction: report.byAction,
            entityAssignment: report.entityAssignment,
            reuseQuality: report.reuseQuality,
            stemDiagnostics: report.stemDiagnostics,
            conflictDiagnostics: report.conflictDiagnostics,
            fuzzyRiskPairs: report.fuzzyRiskPairs,
            geminiAdditionalCalls: report.geminiAdditionalCalls,
            elapsedMs,
          },
          null,
          2
        )
      );
    }
  );
});
