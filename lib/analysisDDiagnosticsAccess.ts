/**
 * Analysis D1-A — validation-only access helpers (presentation / gating).
 * Does not calculate analytics; formats fields from AnalysisDReport only.
 */

import type { AnalysisDReport } from './analysisDReport';
import {
  formatAnalysisDReportSummary,
  serializeAnalysisDReport,
} from './analysisDReport';

export const ANALYSIS_D_EXPORT_PRIVACY_WARNING =
  'This diagnostic report contains private purchase-history data. Share it only when you intentionally choose to.';

/** Settings entry visibility — flag must be explicitly ON. */
export function shouldShowAnalysisDDiagnosticsEntry(
  diagnosticsEnabled: boolean
): boolean {
  return diagnosticsEnabled === true;
}

export type AnalysisDDiagnosticsViewModel = {
  generatedAtLabel: string;
  summaryText: string;
  sections: Array<{ title: string; lines: string[] }>;
};

function pct(rate: number | null): string {
  if (rate == null || !Number.isFinite(rate)) return 'n/a';
  return `${Math.round(rate * 1000) / 10}%`;
}

function dayRangeLabel(
  earliest: number | null,
  latest: number | null
): string {
  if (earliest == null && latest == null) return 'n/a';
  const a =
    earliest != null ? new Date(earliest).toISOString().slice(0, 10) : '?';
  const b = latest != null ? new Date(latest).toISOString().slice(0, 10) : '?';
  return `${a} → ${b}`;
}

/**
 * Thin adapter: all numbers come from the report object.
 * No business-metric recalculation.
 */
export function buildAnalysisDDiagnosticsViewModel(
  report: AnalysisDReport
): AnalysisDDiagnosticsViewModel {
  const exactSpecCount =
    report.specCoverage.volumeExactCount +
    report.specCoverage.weightExactCount +
    report.specCoverage.countExactCount;
  const eligibleIdentity = report.identityCoverage.eligibleItemRows;
  const exactSpecRate =
    eligibleIdentity > 0 ? exactSpecCount / eligibleIdentity : null;
  const familyIdRate =
    eligibleIdentity > 0
      ? report.identityCoverage.withFamily / eligibleIdentity
      : null;
  const canonicalIdRate =
    eligibleIdentity > 0
      ? report.identityCoverage.withCanonical / eligibleIdentity
      : null;

  const allMerchants =
    report.merchants.find((w) => w.window === 'all')?.topMerchants ?? [];
  const allFrequent =
    report.frequentProducts.find((w) => w.window === 'all') ?? null;

  const trendLines = report.trends.map((row) => {
    const state = row.eligible ? 'eligible' : 'suppressed';
    const reason = row.suppressionReason ? ` (${row.suppressionReason})` : '';
    return `${row.window}: ${state}${reason} · current=${row.currentReceiptSampleSize} previous=${row.previousReceiptSampleSize}`;
  });

  return {
    generatedAtLabel: new Date(report.generatedAt).toISOString(),
    summaryText: formatAnalysisDReportSummary(report),
    sections: [
      {
        title: 'Dataset',
        lines: [
          `total receipts: ${report.dataset.totalLocalReceiptCount}`,
          `V1-supported: ${report.dataset.v1SupportedReceiptCount}`,
          `unsupported: ${report.dataset.unsupportedReceiptCount}`,
          `item rows: ${report.dataset.totalItemRowCount}`,
          `date range: ${dayRangeLabel(
            report.dataset.earliestTransactionAt,
            report.dataset.latestTransactionAt
          )}`,
          `supported spend: ${report.dataset.supportedReceiptSpendTotal}`,
        ],
      },
      {
        title: 'Coverage',
        lines: [
          `category amount: ${pct(report.categoryCoverage.classifiedAmountRate)}`,
          `category occurrences: ${pct(
            report.categoryCoverage.classifiedItemOccurrenceRate
          )}`,
          `family identity: ${pct(familyIdRate)}`,
          `canonical identity: ${pct(canonicalIdRate)}`,
          `exact spec: ${pct(exactSpecRate)} (${exactSpecCount}/${eligibleIdentity})`,
          `family normalized-price rows: ${report.priceCoverage.familyNormalizedComparableRows}`,
          `family price coverage: ${pct(report.priceCoverage.familyCoverageRate)}`,
        ],
      },
      {
        title: 'Merchants',
        lines: [
          `distinct supported merchants: ${report.dataset.distinctSupportedMerchantCount}`,
          ...allMerchants
            .slice(0, 5)
            .map(
              (m) =>
                `${m.merchant}: visits=${m.visitCount} spend=${m.supportedSpend}`
            ),
        ],
      },
      {
        title: 'Products',
        lines: [
          `frequent groups (all): ${allFrequent?.frequentProducts.length ?? 0}`,
          `unresolved identity rows: ${
            allFrequent?.unresolvedIdentityItemRows ?? 0
          }`,
        ],
      },
      {
        title: 'Prices',
        lines: [
          `SKU usable rows: ${report.priceCoverage.skuPriceHistoryUsableRows}`,
          `family comparable rows: ${report.priceCoverage.familyNormalizedComparableRows}`,
          `family groups ≥2: ${report.priceCoverage.familyGroupsWithAtLeast2Observations}`,
          `examples: ${report.priceHistoryExamples.length}`,
        ],
      },
      {
        title: 'Trends',
        lines: trendLines.length ? trendLines : ['(no trend windows)'],
      },
      {
        title: 'Insights',
        lines: [`emitted count: ${report.insights.length}`],
      },
      {
        title: 'Corrections',
        lines: [
          `correction events: ${report.corrections.totalCorrectionEvents}`,
          `legacy without provenance: ${report.corrections.legacyEditedRecordsWithoutProvenance}`,
        ],
      },
      {
        title: 'Quality',
        lines: [`flag count: ${report.dataQualityFlags.length}`],
      },
    ],
  };
}

export function buildAnalysisDExportFilename(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `analysis-d-report-${stamp}.json`;
}

export type AnalysisDSharePayload = {
  filename: string;
  json: string;
  privacyWarning: string;
  /** Explicit: share is manual only; never auto-upload. */
  autoUpload: false;
};

/** Build manual share/export payload from an existing report (no recalculation). */
export function buildAnalysisDSharePayload(
  report: AnalysisDReport,
  nowMs: number = Date.now()
): AnalysisDSharePayload {
  return {
    filename: buildAnalysisDExportFilename(nowMs),
    json: serializeAnalysisDReport(report),
    privacyWarning: ANALYSIS_D_EXPORT_PRIVACY_WARNING,
    autoUpload: false,
  };
}
