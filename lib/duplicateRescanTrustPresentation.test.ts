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
    expect(card).toContain('scanReview.duplicateGate.viewSaved');
    expect(card).toContain('scanReview.duplicateGate.continueReview');
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

  it('Continue Review is session-only while View Saved revalidates and preserves the draft', () => {
    expect(screen).toContain('dismissScanReviewDuplicateEvidence');
    expect(screen).toContain('setDismissedDuplicateEvidenceKey');
    expect(screen).toContain('revalidateScanReviewDuplicateDestination');
    expect(screen).toContain('await flushPendingEditorState()');
    expect(screen).toContain('router.push(`/history/${encodeURIComponent(destinationId)}`');
    expect(screen).not.toContain('KEEP_SEPARATE');
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
    expect(screen).toContain('{showDuplicateGate ? (');
    expect(screen).toContain('<ReceiptDuplicateGateCard');
    expect(screen).toContain('{!showDuplicateGate ? (');
    expect(screen).toContain('<ReceiptReviewSaveBar');
    expect(screen).not.toMatch(
      /<ReceiptReviewSaveBar[\s\S]*showDuplicateGate \?/
    );
  });

  it('keeps Continue Review dismissal and re-evaluation paths unchanged', () => {
    expect(screen).toContain('setDismissedDuplicateEvidenceKey(');
    expect(screen).toContain('dismissScanReviewDuplicateEvidence(duplicateGateMatch)');
    expect(screen).toContain('setDuplicateGateMatch(null)');
    expect(screen).toContain('shouldShowScanReviewDuplicateGateMatch(');
    expect(screen).toContain('duplicateGateAnalysis');
    expect(screen).toContain('dismissedDuplicateEvidenceKey');
  });

  it('keeps duplicate-gate localization keys in zh, ja, and en', () => {
    const keys = ['title', 'body', 'viewSaved', 'continueReview', 'itemCount'];
    for (const locale of ['zh', 'ja', 'en']) {
      const parsed = JSON.parse(source(`locales/${locale}.json`));
      expect(Object.keys(parsed.scanReview.duplicateGate).sort()).toEqual(
        [...keys].sort()
      );
      expect(parsed.scanReview.duplicateGate.itemCount).toContain('{count}');
    }
  });
});
