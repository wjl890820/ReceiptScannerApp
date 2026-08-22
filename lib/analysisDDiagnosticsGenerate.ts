/**
 * Analysis D1-A / D2-A — read-only report generation from local receipts.
 * Uses the same listReceipts path as Home / Analysis.
 * Never writes receipts / corrections / outbox / cloud.
 */

import {
  buildAnalysisDDuplicateScanAudit,
  type AnalysisDDuplicateScanAudit,
} from './analysisDDuplicateAudit';
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

export type AnalysisDDiagnosticsBundle = {
  report: AnalysisDReport;
  /** D2-A read-only duplicate / re-scan audit (diagnostic only). */
  duplicateScanAudit: AnalysisDDuplicateScanAudit;
};

async function loadLocalReceipts(
  deps: AnalysisDGenerateDeps
): Promise<{ receipts: ReceiptRow[]; nowMs: number }> {
  const listFn = deps.listReceiptsFn ?? listReceipts;
  const receipts = await listFn(ANALYSIS_D_DIAGNOSTICS_RECEIPT_LIMIT);
  return { receipts, nowMs: deps.nowMs ?? Date.now() };
}

/**
 * Load local receipts once and build both the D0 report and D2-A duplicate audit.
 * Inject listReceiptsFn in tests to prove no write APIs are required.
 */
export async function generateAnalysisDDiagnosticsBundle(
  deps: AnalysisDGenerateDeps = {}
): Promise<AnalysisDDiagnosticsBundle> {
  const { receipts, nowMs } = await loadLocalReceipts(deps);
  return {
    report: buildAnalysisDReport({ receipts, nowMs }),
    duplicateScanAudit: buildAnalysisDDuplicateScanAudit(receipts, nowMs),
  };
}

/**
 * Load local receipts and build AnalysisDReport via D0 harness only.
 * Inject listReceiptsFn in tests to prove no write APIs are required.
 */
export async function generateAnalysisDReportFromLocalReceipts(
  deps: AnalysisDGenerateDeps = {}
): Promise<AnalysisDReport> {
  const { receipts, nowMs } = await loadLocalReceipts(deps);
  return buildAnalysisDReport({ receipts, nowMs });
}
