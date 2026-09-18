/**
 * Short human console summary (no giant JSON).
 */

import { collectTruthRegressions } from './exitCode';
import type { FieldComparison, RegressionReport } from './types';

function fmtChange(c: FieldComparison): string {
  return `${c.field}: ${JSON.stringify(c.baseline)} -> ${JSON.stringify(c.current)}`;
}

export function formatConsoleSummary(report: RegressionReport): string {
  const lines: string[] = [];
  lines.push('Meruno Receipt Regression');
  lines.push('-------------------------');
  lines.push(`Export rows: ${report.summary.rowsLoaded}`);
  lines.push(`Snapshot usable: ${report.summary.snapshotUsable}`);
  lines.push(`Analysis fallback: ${report.summary.analysisFallback}`);
  lines.push(
    `Unavailable/malformed: ${report.summary.unavailable + report.summary.malformedRows}`
  );
  lines.push(`Manifests: ${report.summary.physicalManifests}`);
  lines.push(`Matched: ${report.summary.matchedManifests}`);
  lines.push(`Truth regressions: ${report.summary.truthRegressions}`);
  lines.push(`Stable incorrect: ${report.summary.truthStableIncorrect}`);
  lines.push(`Improvements: ${report.summary.truthImprovements}`);
  lines.push(`Unknown changes: ${report.summary.changedUnknown}`);
  lines.push('');

  const regressions = collectTruthRegressions(report);
  lines.push('REGRESSIONS');
  if (regressions.length === 0) {
    lines.push('- none');
  } else {
    for (const m of report.manifests) {
      for (const c of m.fieldComparisons) {
        if (c.verdict === 'REGRESSION') {
          lines.push(
            `- Receipt${String(m.receiptNo).padStart(3, '0')}.${fmtChange(c)}`
          );
        }
      }
    }
  }
  lines.push('');
  lines.push('STABLE INCORRECT');
  let anyStable = false;
  for (const m of report.manifests) {
    for (const c of m.fieldComparisons) {
      if (c.verdict === 'STABLE_INCORRECT') {
        anyStable = true;
        lines.push(
          `- Receipt${String(m.receiptNo).padStart(3, '0')}.${c.field}: ${JSON.stringify(c.current)} (truth ${JSON.stringify(c.truth)})`
        );
      }
    }
  }
  if (!anyStable) lines.push('- none');

  lines.push('');
  lines.push('IMPROVEMENTS');
  let anyImp = false;
  for (const m of report.manifests) {
    for (const c of m.fieldComparisons) {
      if (c.verdict === 'IMPROVEMENT') {
        anyImp = true;
        lines.push(
          `- Receipt${String(m.receiptNo).padStart(3, '0')}.${fmtChange(c)}`
        );
      }
    }
  }
  if (!anyImp) lines.push('- none');

  lines.push('');
  lines.push(
    `deepConsumers: repeat=${report.deepConsumers.repeat}, pph=${report.deepConsumers.pph}`
  );
  return lines.join('\n');
}
