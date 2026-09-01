/**
 * Analysis D1-A / D2-D — read-only report generation from local receipts.
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
import { selectAnalyticsReceipts } from './analyticsReceiptSelection';
import { listReceipts, type ReceiptRow } from './db';
import {
  buildAnalysisDGyomuCohortForensicsExport,
  serializeAnalysisDGyomuCohortForensicsExport,
  type AnalysisDGyomuCohortForensicsExport,
} from './analysisDGyomuCohortForensics';
import {
  buildAnalysisDRescanForensicsExport,
  serializeAnalysisDRescanForensicsExport,
  type AnalysisDRescanForensicsExport,
} from './analysisDRescanForensics';

/** Same loader Home/Analysis use; higher limit for validation completeness. */
export const ANALYSIS_D_DIAGNOSTICS_RECEIPT_LIMIT = 5000;

export type AnalysisDGenerateDeps = {
  listReceiptsFn?: (limit?: number) => Promise<ReceiptRow[]>;
  nowMs?: number;
};

export type AnalysisDDiagnosticsSelectionMeta = {
  storedReceiptCount: number;
  analyticsPurchaseCandidateCount: number;
  /** Authoritative: excludedDuplicateReceiptIds.size from selectAnalyticsReceipts. */
  highConfidenceDuplicateExtras: number;
  contentExactDuplicateExtras: number;
  structuralExactDuplicateExtras: number;
  reconciledStructuralExactDuplicateExtras: number;
};

export type AnalysisDDiagnosticsBundle = {
  /** Raw stored-scan universe (diagnostic baseline only). */
  storedScanBaseline: AnalysisDReport;
  /** Selected purchase-candidate universe (matches production analytics). */
  productionAnalytics: AnalysisDReport;
  /**
   * @deprecated Prefer productionAnalytics. Kept as alias for older callers.
   * Same object reference as productionAnalytics.
   */
  report: AnalysisDReport;
  duplicateScanAudit: AnalysisDDuplicateScanAudit;
  selection: AnalysisDDiagnosticsSelectionMeta;
};

async function loadLocalReceipts(
  deps: AnalysisDGenerateDeps
): Promise<{ receipts: ReceiptRow[]; nowMs: number }> {
  const listFn = deps.listReceiptsFn ?? listReceipts;
  const receipts = await listFn(ANALYSIS_D_DIAGNOSTICS_RECEIPT_LIMIT);
  return { receipts, nowMs: deps.nowMs ?? Date.now() };
}

/**
 * Load local receipts once and build stored baseline + production analytics + D2-A audit.
 * Inject listReceiptsFn in tests to prove no write APIs are required.
 */
export async function generateAnalysisDDiagnosticsBundle(
  deps: AnalysisDGenerateDeps = {}
): Promise<AnalysisDDiagnosticsBundle> {
  const { receipts, nowMs } = await loadLocalReceipts(deps);
  const selection = selectAnalyticsReceipts(receipts);
  const storedScanBaseline = buildAnalysisDReport({ receipts, nowMs });
  const productionAnalytics = buildAnalysisDReport({
    receipts: selection.analyticsReceipts,
    nowMs,
  });
  const duplicateScanAudit = buildAnalysisDDuplicateScanAudit(receipts, nowMs);
  return {
    storedScanBaseline,
    productionAnalytics,
    report: productionAnalytics,
    duplicateScanAudit,
    selection: {
      storedReceiptCount: selection.storedReceipts.length,
      analyticsPurchaseCandidateCount: selection.analyticsPurchaseCandidateCount,
      highConfidenceDuplicateExtras: selection.highConfidenceDuplicateExtras,
      contentExactDuplicateExtras: selection.contentExactDuplicateExtras,
      structuralExactDuplicateExtras: selection.structuralExactDuplicateExtras,
      reconciledStructuralExactDuplicateExtras:
        selection.reconciledStructuralExactDuplicateExtras,
    },
  };
}

/**
 * Load local receipts and build production (selected) AnalysisDReport via D0 harness.
 * Inject listReceiptsFn in tests to prove no write APIs are required.
 */
export async function generateAnalysisDReportFromLocalReceipts(
  deps: AnalysisDGenerateDeps = {}
): Promise<AnalysisDReport> {
  const bundle = await generateAnalysisDDiagnosticsBundle(deps);
  return bundle.productionAnalytics;
}

/**
 * Load local receipts and build the Gyomu ¥3,393 full-cohort forensic export.
 * Read-only; inject listReceiptsFn in tests.
 */
export async function generateAnalysisDGyomuCohortForensicsExport(
  deps: AnalysisDGenerateDeps = {}
): Promise<{ payload: AnalysisDGyomuCohortForensicsExport; json: string }> {
  const { receipts, nowMs } = await loadLocalReceipts(deps);
  const payload = buildAnalysisDGyomuCohortForensicsExport({ receipts, nowMs });
  return {
    payload,
    json: serializeAnalysisDGyomuCohortForensicsExport(payload),
  };
}

/**
 * Load local receipts and build the known Costco re-scan forensic export.
 * Read-only; inject listReceiptsFn in tests.
 */
export async function generateAnalysisDRescanForensicsExport(
  deps: AnalysisDGenerateDeps = {}
): Promise<{ payload: AnalysisDRescanForensicsExport; json: string }> {
  const { receipts, nowMs } = await loadLocalReceipts(deps);
  const payload = buildAnalysisDRescanForensicsExport({ receipts, nowMs });
  return {
    payload,
    json: serializeAnalysisDRescanForensicsExport(payload),
  };
}
