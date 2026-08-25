jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('./db', () => ({ initIfNeeded: jest.fn(async () => undefined) }));

import * as fs from 'fs';
import * as path from 'path';

import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { buildInsights } from './buildInsights';
import {
  countSupportedItemsInRange,
  filterReceiptsByTimeRange,
} from './analysisPresentation';
import { isV1SupportedReceipt } from './merchantType';
import { receiptRowFromIntelligenceExport } from './productIdentityShadowAuditDataset';
import { calculateStats } from './statsCalculator';

const ARTIFACT = path.join(
  __dirname,
  '../artifacts/product-intelligence-audit.json'
);
const REFERENCE_NOW = Date.parse('2026-08-25T03:00:00.000Z');

describe('Analysis period truth — 127 receipt live control', () => {
  const hasArtifact = fs.existsSync(ARTIFACT);

  (hasArtifact ? it : it.skip)(
    'preserves all history while excluding unknown dates from rolling periods',
    () => {
      jest.spyOn(Date, 'now').mockReturnValue(REFERENCE_NOW);
      try {
        const payload = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
        const storedReceipts = (payload.receipts ?? []).map(
          receiptRowFromIntelligenceExport
        );
        const selection = selectAnalyticsReceipts(storedReceipts);
        const allStats = calculateStats(selection.analyticsReceipts, 'all');
        const monthStats = calculateStats(selection.analyticsReceipts, 'month');
        const weekStats = calculateStats(selection.analyticsReceipts, 'week');
        const monthReceipts = filterReceiptsByTimeRange(
          selection.analyticsReceipts,
          'month',
          REFERENCE_NOW
        );
        const weekReceipts = filterReceiptsByTimeRange(
          selection.analyticsReceipts,
          'week',
          REFERENCE_NOW
        );
        const monthInsights = buildInsights(
          selection.analyticsReceipts,
          'month'
        );
        const weekInsights = buildInsights(selection.analyticsReceipts, 'week');

        expect(selection.storedReceipts).toHaveLength(127);
        expect(selection.highConfidenceDuplicateExtras).toBe(23);
        expect(selection.analyticsReceipts).toHaveLength(104);
        expect(allStats.supportedReceiptCount).toBe(100);
        expect(allStats.supportedSpend).toBe(424878);
        expect(
          countSupportedItemsInRange(
            selection.analyticsReceipts,
            'all',
            REFERENCE_NOW
          )
        ).toBe(932);

        expect(monthStats.supportedReceiptCount).toBe(7);
        expect(monthStats.supportedSpend).toBe(19521);
        expect(weekStats.supportedReceiptCount).toBe(0);
        expect(weekStats.supportedSpend).toBe(0);

        expect(
          [...monthReceipts, ...weekReceipts].filter(
            (receipt) =>
              isV1SupportedReceipt(receipt) &&
              !(
                typeof receipt.transaction_at === 'number' &&
                Number.isFinite(receipt.transaction_at) &&
                receipt.transaction_at > 0
              )
          )
        ).toHaveLength(0);
        expect(
          monthReceipts.every(
            (receipt) => Number(receipt.transaction_at) <= REFERENCE_NOW
          )
        ).toBe(true);
        expect(
          weekReceipts.every(
            (receipt) => Number(receipt.transaction_at) <= REFERENCE_NOW
          )
        ).toBe(true);

        expect(monthInsights.currentStats.supportedReceiptCount).toBe(7);
        expect(monthInsights.currentStats.supportedSpend).toBe(19521);
        expect(weekInsights.currentStats.supportedReceiptCount).toBe(0);
        expect(weekInsights.currentStats.supportedSpend).toBe(0);
      } finally {
        jest.restoreAllMocks();
      }
    }
  );
});
