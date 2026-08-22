/**
 * Analysis D1-A — read-only report generation from local receipts.
 * Uses the same listReceipts path as Home / Analysis.
 * Never writes receipts / corrections / outbox / cloud.
 */

import {
  buildAnalysisDReport,
  type AnalysisDReport,
} from './analysisDReport';
import { listReceipts, type ReceiptRow } from './db';

/** Same loader Home/Analysis use; higher limit for validation completeness. */
export const ANALYSIS_D_DIAGNOSTICS_RECEIPT_LIMIT = 5000;

export type AnalysisDGenerateDeps = {
  listReceiptsFn?: (limit?: number) => Promise<ReceiptRow[]>;
  nowMs?: number;
};

/**
 * Load local receipts and build AnalysisDReport via D0 harness only.
 * Inject listReceiptsFn in tests to prove no write APIs are required.
 */
export async function generateAnalysisDReportFromLocalReceipts(
  deps: AnalysisDGenerateDeps = {}
): Promise<AnalysisDReport> {
  const listFn = deps.listReceiptsFn ?? listReceipts;
  const receipts = await listFn(ANALYSIS_D_DIAGNOSTICS_RECEIPT_LIMIT);
  return buildAnalysisDReport({
    receipts,
    nowMs: deps.nowMs,
  });
}
