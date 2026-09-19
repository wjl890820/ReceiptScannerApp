/**
 * Exit-code policy for Phase 2 deep regression CLI.
 */

import type { DeepRegressionReport } from './deepTypes';

export function resolveDeepExitCode(input: {
  harnessFailed: boolean;
  report: DeepRegressionReport | null;
}): number {
  if (input.harnessFailed) return 1;
  if (!input.report) return 1;
  const inv = input.report.deep.invariants;
  if (!inv.readyRequiresTwoComparablePoints) return 1;
  if (!inv.rescansDoNotInflateRepeatOccurrences) return 1;
  if (!inv.rescansDoNotInflateRepeatQuantity) return 1;
  if (!inv.rescansDoNotInflateComparablePoints) return 1;
  if (!inv.rescansDoNotInflatePphGrossOrQuantity) return 1;
  return 0;
}
