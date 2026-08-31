import * as fs from 'fs';
import * as path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function showDuplicateGatePresentation(
  match: { evidenceKey: string } | null,
  dismissedEvidenceKey: string | null
): boolean {
  return Boolean(match && match.evidenceKey !== dismissedEvidenceKey);
}

const sampleMatch = {
  existingReceiptId: 'receipt-a',
  evidenceKey: 'evidence-a',
  merchantDisplay: 'Costco',
  transactionAt: 1,
  total: 1000,
  currency: 'JPY',
  itemCount: 3,
};

describe('duplicate gate CTA presentation', () => {
  it('shows the gate and hides Save only while the active match is not dismissed', () => {
    expect(showDuplicateGatePresentation(sampleMatch, null)).toBe(true);
    expect(showDuplicateGatePresentation(sampleMatch, 'evidence-a')).toBe(false);
    expect(showDuplicateGatePresentation(null, null)).toBe(false);
  });

  it('shows the gate again when material evidence changes to a new key', () => {
    const nextMatch = { ...sampleMatch, evidenceKey: 'evidence-b' };
    expect(showDuplicateGatePresentation(nextMatch, 'evidence-a')).toBe(true);
  });
});

describe('duplicate rescan trust presentation integration', () => {
  const screen = source('app/scan-review/[draftId].tsx');
  const card = source('components/review/ReceiptDuplicateGateCard.tsx');
  const settings = source('app/(tabs)/settings/index.tsx');

  it('keeps the advisory card thin, localized, and non-destructive', () => {
    expect(card).toContain('scanReview.duplicateGate.title');
    expect(card).toContain('scanReview.duplicateGate.useSaved');
    expect(card).toContain('scanReview.duplicateGate.continueReview');
    expect(card).not.toContain('viewSaved');
    expect(card).not.toContain('这张小票');
    expect(card).not.toContain('このレシート');
    expect(card).not.toContain('This receipt may');
    expect(card).not.toContain('saveReceipt');
    expect(card).not.toContain('deleteReceipt');
  });

  it('debounces material evidence and guards draft generation/unmount updates', () => {
    expect(screen).toContain('setTimeout(() =>');
    expect(screen).toContain('shouldApplyScanReviewDuplicateGateUpdate');
    expect(screen).toContain('duplicateGateMountedRef.current');
    expect(screen).toContain('currentDraftIdRef.current');
    expect(screen).toContain('duplicateGateGenerationRef.current');
  });

  it('enters terminal navigation recovery after completed_navigation_failed', () => {
    const useSavedBlock = screen.slice(
      screen.indexOf('const onUseSavedDuplicateReceipt'),
      screen.indexOf('const onRetrySavedReceiptNavigation')
    );
    expect(useSavedBlock).toContain('reduceTerminalDuplicateDestinationId');
    expect(useSavedBlock).toContain("result.status === 'completed_navigation_failed'");
    expect(useSavedBlock).toContain('setTerminalDuplicateDestinationId');
    expect(useSavedBlock).toContain('terminalDuplicateDestinationId');
  });

  it('retries navigation only through onRetrySavedReceiptNavigation', () => {
    const retryBlock = screen.slice(
      screen.indexOf('const onRetrySavedReceiptNavigation'),
      screen.indexOf('const snapItemsArr')
    );
    expect(retryBlock).toContain('router.replace');
    expect(retryBlock).not.toContain('executeDuplicateGateTerminalFlow');
    expect(retryBlock).not.toContain('terminateDuplicateScanReviewDraft');
    expect(retryBlock).not.toContain('removeScanReviewDraft');
    expect(retryBlock).not.toContain('peekNextDraftId');
    expect(retryBlock).not.toContain('persistPayloadRef');
  });

  it('blocks a second terminal coordinator run after terminal completion', () => {
    const useSavedBlock = screen.slice(
      screen.indexOf('const onUseSavedDuplicateReceipt'),
      screen.indexOf('const onRetrySavedReceiptNavigation')
    );
    expect(useSavedBlock).toContain('terminalDuplicateDestinationId');
    expect(useSavedBlock).toMatch(/if \([\s\S]*terminalDuplicateDestinationId[\s\S]*\) \{\s*return;/);
  });

  it('shows terminal recovery UI and hides unresolved gate actions after completion', () => {
    expect(screen).toContain('ReceiptDuplicateGateRecoveryCard');
    expect(screen).toContain('showUnresolvedDuplicateGate');
    expect(screen).toContain('showDuplicateTerminalRecovery');
    expect(screen).toContain('hideDuplicateGateSaveBar');
    expect(screen).toContain('shouldHideDuplicateGateSaveBar');
    expect(screen).toContain('setTerminalDuplicateDestinationId(null)');
  });

  it('routes the primary action through the production terminal coordinator', () => {
    const useSavedBlock = screen.slice(
      screen.indexOf('const onUseSavedDuplicateReceipt'),
      screen.indexOf('const snapItemsArr')
    );
    expect(screen).toContain('onUseSavedDuplicateReceipt');
    expect(useSavedBlock).toContain('executeDuplicateGateTerminalFlow');
    expect(useSavedBlock).not.toMatch(/if \(!termination\.ok\)/);
    expect(useSavedBlock).not.toContain('router.push');
    expect(useSavedBlock).not.toContain('flushPendingEditorState');
    expect(useSavedBlock).not.toContain('saveReceipt');
    expect(useSavedBlock).not.toContain('KEEP_SEPARATE');
  });

  it('surfaces termination failure from the coordinator without duplicating orchestration', () => {
    const useSavedBlock = screen.slice(
      screen.indexOf('const onUseSavedDuplicateReceipt'),
      screen.indexOf('const snapItemsArr')
    );
    expect(useSavedBlock).toContain("result.status === 'termination_failed'");
    expect(useSavedBlock).toContain("t('scanReview.duplicateGate.useSavedFailedMessage')");
    expect(useSavedBlock).toMatch(
      /result\.status === 'termination_failed'[\s\S]*Alert\.alert/
    );
  });

  it('contains no temporary TestFlight diagnostic override', () => {
    expect(settings).not.toContain('DUPLICATE_INCIDENT_DIAGNOSTIC_BUILD');
    expect(settings).not.toContain('TEMPORARY DIAGNOSTIC');
    expect(settings).toContain('if (!__DEV__) return;');
    expect(settings).toContain('isDevBuild: __DEV__');
  });

  it('hides sticky Save while the duplicate gate is active and restores it after dismissal', () => {
    expect(screen).toContain('const showDuplicateGate = shouldShowScanReviewDuplicateGateMatch(');
    expect(screen).toContain('duplicateGateMatch');
    expect(screen).toContain('dismissedDuplicateEvidenceKey');
    expect(screen).toContain('showUnresolvedDuplicateGate');
    expect(screen).toContain('<ReceiptDuplicateGateCard');
    expect(screen).toContain('hideDuplicateGateSaveBar');
    expect(screen).toContain('{!hideDuplicateGateSaveBar ? (');
    expect(screen).toContain('<ReceiptReviewSaveBar');
    expect(screen).not.toMatch(
      /<ReceiptReviewSaveBar[\s\S]*showDuplicateGate \?/
    );
  });

  it('keeps Continue Review off the terminal coordinator path', () => {
    const continueBlock = screen.slice(
      screen.indexOf('const onContinueDuplicateReview'),
      screen.indexOf('const onUseSavedDuplicateReceipt')
    );
    expect(continueBlock).toContain('dismissScanReviewDuplicateEvidence');
    expect(continueBlock).not.toContain('executeDuplicateGateTerminalFlow');
    expect(continueBlock).not.toContain('terminateDuplicateScanReviewDraft');
    expect(continueBlock).not.toContain('removeScanReviewDraft');
  });

  it('keeps Continue Review dismissal and re-evaluation paths unchanged', () => {
    expect(screen).toContain('setDismissedDuplicateEvidenceKey(');
    expect(screen).toContain('dismissScanReviewDuplicateEvidence(duplicateGateMatch)');
    expect(screen).toContain('setDuplicateGateMatch(null)');
    expect(screen).toContain('shouldShowScanReviewDuplicateGateMatch(');
    expect(screen).toContain('duplicateGateAnalysis');
    expect(screen).toContain('dismissedDuplicateEvidenceKey');
    expect(screen).toContain('onContinueDuplicateReview');
  });

  it('keeps duplicate-gate localization keys in zh, ja, and en', () => {
    const keys = [
      'title',
      'body',
      'useSaved',
      'useSavedFailedTitle',
      'useSavedFailedMessage',
      'recoveryTitle',
      'recoveryBody',
      'openRecordAgain',
      'continueReview',
      'itemCount',
    ];
    const expectedCopy = {
      en: 'Use saved record',
      ja: '保存済みの記録を使用',
      zh: '使用已保存记录',
    } as const;
    const expectedRecoveryTitle = {
      en: 'Saved record selected',
      ja: '保存済みの記録を使用しました',
      zh: '已使用保存的记录',
    } as const;
    for (const locale of ['zh', 'ja', 'en'] as const) {
      const parsed = JSON.parse(source(`locales/${locale}.json`));
      expect(Object.keys(parsed.scanReview.duplicateGate).sort()).toEqual(
        [...keys].sort()
      );
      expect(parsed.scanReview.duplicateGate.itemCount).toContain('{count}');
      expect(parsed.scanReview.duplicateGate.useSaved).toBe(expectedCopy[locale]);
      expect(parsed.scanReview.duplicateGate.recoveryTitle).toBe(
        expectedRecoveryTitle[locale]
      );
    }
  });
});
