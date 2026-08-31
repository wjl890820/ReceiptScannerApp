/**
 * Terminal lifecycle for duplicate Scan Review drafts when the user chooses the
 * already-saved receipt as canonical. Presentation/navigation only — no save.
 */

export type TerminateDuplicateScanReviewDraftDeps = {
  removeDraft?: (draftId: string) => Promise<void>;
  advanceQueue?: (removedDraftId: string) => Promise<string | null>;
  maxAttempts?: number;
};

export type TerminateDuplicateScanReviewDraftResult =
  | { ok: true; nextDraftId: string | null; queueClean: boolean }
  | { ok: false; reason: 'remove_failed' };

export type DuplicateGateTerminalFlowInput = {
  currentDraftId: string;
  existingReceiptId: string;
};

export type DuplicateGateTerminalFlowDeps = {
  revalidateDestination: (existingReceiptId: string) => Promise<boolean>;
  terminateDraft: (
    currentDraftId: string
  ) => Promise<TerminateDuplicateScanReviewDraftResult>;
  clearPendingPersistence: () => void;
  allowLeave: () => void;
  replaceWithHistory: (existingReceiptId: string) => void | Promise<void>;
  isStillCurrent?: () => boolean;
};

export type DuplicateGateTerminalFlowResult =
  | { status: 'stale' }
  | { status: 'ownership_failed' }
  | { status: 'termination_failed' }
  | { status: 'completed' }
  | { status: 'completed_navigation_failed'; error: unknown };

export type ScanReviewDuplicateTerminalUiPhase =
  | 'unresolved'
  | 'recoverable_terminal_navigation';

export function reduceTerminalDuplicateDestinationId(
  currentDestinationId: string | null,
  input: {
    result: DuplicateGateTerminalFlowResult;
    existingReceiptId: string;
  }
): string | null {
  if (input.result.status === 'completed_navigation_failed') {
    return input.existingReceiptId;
  }
  return currentDestinationId;
}

export function resolveScanReviewDuplicateTerminalUiPhase(input: {
  terminalDuplicateDestinationId: string | null;
}): ScanReviewDuplicateTerminalUiPhase {
  return input.terminalDuplicateDestinationId
    ? 'recoverable_terminal_navigation'
    : 'unresolved';
}

export function shouldShowUnresolvedDuplicateGate(input: {
  showDuplicateGate: boolean;
  terminalDuplicateDestinationId: string | null;
}): boolean {
  return (
    input.showDuplicateGate &&
    resolveScanReviewDuplicateTerminalUiPhase(input) === 'unresolved'
  );
}

export function shouldShowDuplicateTerminalRecovery(input: {
  terminalDuplicateDestinationId: string | null;
}): boolean {
  return resolveScanReviewDuplicateTerminalUiPhase(input) ===
    'recoverable_terminal_navigation';
}

export function shouldHideDuplicateGateSaveBar(input: {
  showDuplicateGate: boolean;
  terminalDuplicateDestinationId: string | null;
}): boolean {
  return (
    shouldShowUnresolvedDuplicateGate(input) ||
    shouldShowDuplicateTerminalRecovery(input)
  );
}

export function shouldAllowTerminalRecoveryNavigationRetry(input: {
  terminalDuplicateDestinationId: string | null;
  processing: boolean;
}): boolean {
  return Boolean(input.terminalDuplicateDestinationId) && !input.processing;
}

function isCurrent(deps: DuplicateGateTerminalFlowDeps): boolean {
  return deps.isStillCurrent?.() ?? true;
}

/**
 * Production orchestration for the duplicate gate primary action.
 * Enforces ownership → termination → persistence clear → leave → replace.
 */
export async function executeDuplicateGateTerminalFlow(
  input: DuplicateGateTerminalFlowInput,
  deps: DuplicateGateTerminalFlowDeps
): Promise<DuplicateGateTerminalFlowResult> {
  const owned = await deps.revalidateDestination(input.existingReceiptId);
  if (!isCurrent(deps)) {
    return { status: 'stale' };
  }
  if (!owned) {
    return { status: 'ownership_failed' };
  }
  if (!isCurrent(deps)) {
    return { status: 'stale' };
  }

  const termination = await deps.terminateDraft(input.currentDraftId);
  if (!isCurrent(deps)) {
    return { status: 'stale' };
  }
  if (!termination.ok) {
    return { status: 'termination_failed' };
  }

  deps.clearPendingPersistence();
  deps.allowLeave();

  try {
    await deps.replaceWithHistory(input.existingReceiptId);
  } catch (error) {
    return { status: 'completed_navigation_failed', error };
  }

  return { status: 'completed' };
}

/**
 * Remove the current duplicate draft and drop it from the review queue while
 * preserving any remaining queued drafts.
 */
export async function terminateDuplicateScanReviewDraft(
  currentDraftId: string,
  deps: TerminateDuplicateScanReviewDraftDeps = {}
): Promise<TerminateDuplicateScanReviewDraftResult> {
  if (!currentDraftId) {
    return { ok: false, reason: 'remove_failed' };
  }

  const removeDraft = deps.removeDraft;
  const advanceQueue = deps.advanceQueue;
  const maxAttempts = deps.maxAttempts ?? 3;

  if (!removeDraft || !advanceQueue) {
    return { ok: false, reason: 'remove_failed' };
  }

  let removed = false;
  for (let attempt = 1; attempt <= maxAttempts && !removed; attempt++) {
    try {
      await removeDraft(currentDraftId);
      removed = true;
    } catch {
      // Conservative retry before claiming terminal completion.
    }
  }

  if (!removed) {
    return { ok: false, reason: 'remove_failed' };
  }

  let nextDraftId: string | null = null;
  let queueClean = true;
  try {
    nextDraftId = await advanceQueue(currentDraftId);
  } catch {
    // Draft is already gone; queue repair happens on the next pending-review read.
    nextDraftId = null;
    queueClean = false;
  }

  return { ok: true, nextDraftId, queueClean };
}
