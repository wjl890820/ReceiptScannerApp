/**
 * Exit-code policy for the regression CLI.
 */

import type { FieldComparison, RegressionReport } from './types';

export function collectTruthRegressions(
  report: RegressionReport
): FieldComparison[] {
  const out: FieldComparison[] = [];
  for (const m of report.manifests) {
    for (const c of m.fieldComparisons) {
      if (c.verdict === 'REGRESSION') out.push(c);
    }
  }
  return out;
}

/**
 * Default: exit 0 even with behavioral diffs.
 * --fail-on-regression: exit 1 only for human-truth REGRESSION or harness failure.
 */
export function resolveExitCode(input: {
  failOnRegression: boolean;
  harnessFailed: boolean;
  report: RegressionReport | null;
}): number {
  if (input.harnessFailed) return 1;
  if (!input.failOnRegression) return 0;
  if (!input.report) return 1;
  return collectTruthRegressions(input.report).length > 0 ? 1 : 0;
}
