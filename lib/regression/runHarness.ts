/**
 * Phase 1 offline snapshot regression harness runner.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import { runDeterministicChecks } from './deterministicChecks';
import { gradeAgainstTruth, gradeNoTruthDelta, tallyVerdicts } from './gradeTruth';
import {
  loadAllHistoricalRows,
  loadExportEnvelope,
} from './parseExport';
import {
  classifyUnmatchedReason,
  matchManifestToRows,
  memberObservation,
  pickRepresentativeRow,
} from './matchManifest';
import { projectCanonicalFromPayload } from './projectCanonical';
import { redactForReport } from './privacy';
import {
  REGRESSION_HARNESS_VERSION,
  type FieldVerdict,
  type MatchedManifestResult,
  type MatchedMemberObservation,
  type RegressionManifest,
  type RegressionReport,
} from './types';

export type RunHarnessOptions = {
  exportPath: string;
  manifestDir?: string;
  failOnRegression?: boolean;
  gitHead?: string | null;
};

function tryGitHead(): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function loadManifestsFromDir(dir: string): RegressionManifest[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out: RegressionManifest[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (raw && typeof raw === 'object' && raw.schemaVersion === 1) {
        out.push(raw as RegressionManifest);
      }
    } catch {
      // skip malformed manifest files; caller may log
    }
  }
  return out;
}

export function runRegressionHarness(
  options: RunHarnessOptions
): RegressionReport {
  const exportAbs = path.resolve(options.exportPath);
  const rawText = fs.readFileSync(exportAbs, 'utf8');
  const envelope = loadExportEnvelope(JSON.parse(rawText));
  const rows = loadAllHistoricalRows(envelope);

  const defaultManifestDir = path.join(
    process.cwd(),
    'fixtures',
    'regression',
    'manifests'
  );
  const manifests = loadManifestsFromDir(
    options.manifestDir
      ? path.resolve(options.manifestDir)
      : defaultManifestDir
  );

  const reportRows: RegressionReport['rows'] = [];
  let snapshotUsable = 0;
  let analysisFallback = 0;
  let unavailable = 0;
  let malformedRows = 0;

  for (const row of rows) {
    if (row.parseError) malformedRows += 1;
    if (row.baselineStage === 'recognition_snapshot') snapshotUsable += 1;
    else if (row.baselineStage === 'analysis_current') analysisFallback += 1;
    else unavailable += 1;

    if (!row.baselinePayload) {
      reportRows.push({
        receiptId: row.receiptId,
        baselineStage: row.baselineStage,
        fallbackReason: row.fallbackReason,
        parseError: row.parseError,
        observed: null,
        current: null,
        noTruthFieldComparisons: [],
      });
      continue;
    }

    const observed = projectCanonicalFromPayload(row.baselinePayload, {
      merchantRaw: row.merchantRaw,
      merchantNormalized: row.merchantNormalized,
      total: row.total,
      tax: row.tax,
      currency: row.currency,
      transactionAtMs: row.transactionAt,
    });
    const current = runDeterministicChecks(row.baselinePayload, {
      receiptId: row.receiptId,
      merchantRaw: row.merchantRaw,
      merchantNormalized: row.merchantNormalized,
      total: row.total,
      tax: row.tax,
      currency: row.currency,
      transactionAtMs: row.transactionAt,
    });
    const noTruthFieldComparisons = gradeNoTruthDelta(
      observed,
      current.projection
    );

    reportRows.push({
      receiptId: row.receiptId,
      baselineStage: row.baselineStage,
      fallbackReason: row.fallbackReason,
      parseError: row.parseError,
      observed,
      current,
      noTruthFieldComparisons,
    });
  }

  const manifestResults: MatchedManifestResult[] = [];
  for (const manifest of manifests) {
    const matches = matchManifestToRows(manifest, rows);
    const observationalSourceReceiptIds = (manifest.sourceReceiptIds ?? []).filter(
      (x) => typeof x === 'string' && x
    );

    if (matches.length === 0) {
      manifestResults.push({
        receiptNo: manifest.receiptNo,
        matchedHistoricalRows: [],
        duplicateHistoricalRows: false,
        representativeReceiptId: null,
        representativeRule: null,
        unmatched: true,
        unmatchedReason: classifyUnmatchedReason(manifest, rows),
        fieldComparisons: [],
        merchantCompare: null,
        completeBasket: manifest.truth.completeBasket === true,
        matchedMembers: [],
        observationalSourceReceiptIds,
      });
      continue;
    }

    const rep = pickRepresentativeRow(matches);
    const repRow = rep!.row;

    const fingerprintExpected =
      manifest.selectors?.orderedLineAmountsFingerprint ??
      manifest.truth.orderedLineAmounts ??
      null;

    const buildMember = (row: typeof matches[0]): MatchedMemberObservation => {
      const obs = memberObservation(row, fingerprintExpected);
      if (!row.baselinePayload) {
        return { ...obs, fieldComparisons: [] };
      }
      const observed = projectCanonicalFromPayload(row.baselinePayload, {
        merchantRaw: row.merchantRaw,
        merchantNormalized: row.merchantNormalized,
        total: row.total,
        tax: row.tax,
        currency: row.currency,
        transactionAtMs: row.transactionAt,
      });
      // Member grades: observed vs truth only (current === observed for listing).
      const graded = gradeAgainstTruth({
        truth: manifest.truth,
        baseline: observed,
        current: observed,
      });
      const focus = graded.comparisons.filter((c) =>
        ['transactionAt', 'tax', 'total', 'itemRowCount', 'orderedLineAmounts'].includes(
          c.field
        )
      );
      return { ...obs, fieldComparisons: focus };
    };

    const matchedMembers = matches.map(buildMember);

    if (!repRow.baselinePayload) {
      manifestResults.push({
        receiptNo: manifest.receiptNo,
        matchedHistoricalRows: matches.map((m) => m.receiptId),
        duplicateHistoricalRows: matches.length > 1,
        representativeReceiptId: repRow.receiptId,
        representativeRule: rep!.rule,
        unmatched: false,
        unmatchedReason: null,
        fieldComparisons: [],
        merchantCompare: null,
        completeBasket: manifest.truth.completeBasket === true,
        matchedMembers,
        observationalSourceReceiptIds,
      });
      continue;
    }

    const observed = projectCanonicalFromPayload(repRow.baselinePayload, {
      merchantRaw: repRow.merchantRaw,
      merchantNormalized: repRow.merchantNormalized,
      total: repRow.total,
      tax: repRow.tax,
      currency: repRow.currency,
      transactionAtMs: repRow.transactionAt,
    });
    const current = runDeterministicChecks(repRow.baselinePayload, {
      receiptId: repRow.receiptId,
      merchantRaw: repRow.merchantRaw,
      merchantNormalized: repRow.merchantNormalized,
      total: repRow.total,
      tax: repRow.tax,
      currency: repRow.currency,
      transactionAtMs: repRow.transactionAt,
    });
    const graded = gradeAgainstTruth({
      truth: manifest.truth,
      baseline: observed,
      current: current.projection,
    });

    manifestResults.push({
      receiptNo: manifest.receiptNo,
      matchedHistoricalRows: matches.map((m) => m.receiptId),
      duplicateHistoricalRows: matches.length > 1,
      representativeReceiptId: repRow.receiptId,
      representativeRule: rep!.rule,
      unmatched: false,
      unmatchedReason: null,
      fieldComparisons: graded.comparisons,
      merchantCompare: graded.merchantCompare,
      completeBasket: graded.completeBasket,
      matchedMembers,
      observationalSourceReceiptIds,
    });
  }

  const allManifestComps = manifestResults.flatMap((m) => m.fieldComparisons);
  const allNoTruth = reportRows.flatMap((r) => r.noTruthFieldComparisons);
  const talliedAll = tallyVerdicts([...allManifestComps, ...allNoTruth]);
  const talliedTruth = tallyVerdicts(allManifestComps);

  const report: RegressionReport = {
    metadata: {
      generatedAt: new Date().toISOString(),
      exportPathBasename: path.basename(exportAbs),
      exportReceiptRowCount: envelope.receiptCount ?? envelope.receipts.length,
      harnessVersion: REGRESSION_HARNESS_VERSION,
      gitHead: options.gitHead !== undefined ? options.gitHead : tryGitHead(),
      failOnRegression: Boolean(options.failOnRegression),
    },
    summary: {
      rowsLoaded: rows.length,
      snapshotUsable,
      analysisFallback,
      unavailable,
      malformedRows,
      physicalManifests: manifests.length,
      matchedManifests: manifestResults.filter((m) => !m.unmatched).length,
      unmatchedManifests: manifestResults.filter((m) => m.unmatched).length,
      correctStable: talliedAll.CORRECT_STABLE,
      improvements: talliedAll.IMPROVEMENT,
      regressions: talliedAll.REGRESSION,
      changedStillIncorrect: talliedAll.CHANGED_STILL_INCORRECT,
      stableIncorrect: talliedAll.STABLE_INCORRECT,
      unknown: talliedAll.UNKNOWN,
      unchangedNoTruth: talliedAll.UNCHANGED,
      changedUnknown: talliedAll.CHANGED_UNKNOWN,
      truthCorrectStable: talliedTruth.CORRECT_STABLE,
      truthImprovements: talliedTruth.IMPROVEMENT,
      truthRegressions: talliedTruth.REGRESSION,
      truthStableIncorrect: talliedTruth.STABLE_INCORRECT,
      truthChangedStillIncorrect: talliedTruth.CHANGED_STILL_INCORRECT,
      truthUnknown: talliedTruth.UNKNOWN,
    },
    deepConsumers: {
      repeat: 'not_run_phase1',
      pph: 'not_run_phase1',
    },
    rows: reportRows,
    manifests: manifestResults,
  };

  return redactForReport(report);
}

export function countVerdict(
  report: RegressionReport,
  verdict: FieldVerdict
): number {
  return (
    report.manifests
      .flatMap((m) => m.fieldComparisons)
      .filter((c) => c.verdict === verdict).length
  );
}
