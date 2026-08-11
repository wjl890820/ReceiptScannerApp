import * as fs from 'fs';
import * as path from 'path';

import {
  shouldShowLegacyPostSaveEasterEggAlert,
  shouldShowRecognizedNameHint,
  shouldShowReviewDevDetails,
} from './scanReviewPresentation';

describe('scanReview presentation visibility', () => {
  it('hides OCR original when the edited name matches recognition', () => {
    expect(shouldShowRecognizedNameHint('牛乳', '牛乳')).toBe(false);
    expect(shouldShowRecognizedNameHint(' 牛乳 ', '牛乳')).toBe(false);
  });

  it('shows OCR original only when the edited name differs', () => {
    expect(shouldShowRecognizedNameHint('明治牛乳', '牛乳')).toBe(true);
    expect(shouldShowRecognizedNameHint('牛乳', '')).toBe(false);
    expect(shouldShowRecognizedNameHint('牛乳', null)).toBe(false);
  });

  it('keeps OCR/trace details behind the developer gate in release mode', () => {
    expect(shouldShowReviewDevDetails(false, false)).toBe(false);
    expect(shouldShowReviewDevDetails(true, false)).toBe(true);
    expect(shouldShowReviewDevDetails(false, true)).toBe(true);
  });

  it('disables legacy post-save easter egg Alerts on Release builds', () => {
    expect(shouldShowLegacyPostSaveEasterEggAlert(false)).toBe(false);
    expect(shouldShowLegacyPostSaveEasterEggAlert(true)).toBe(true);
  });
});

describe('scanReview release UI presentation wiring', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../app/scan-review/[draftId].tsx'),
    'utf8'
  );

  it('does not render OCR/trace/debug blocks by default in the main tree', () => {
    expect(source).toContain('ReceiptReviewDetails');
    expect(source).toContain('shouldShowReviewDevDetails');
    expect(source).toContain('ReceiptReviewSaveBar');
    expect(source).not.toMatch(/styles\.ocrBlock/);
    expect(source).not.toMatch(/styles\.mono/);
  });

  it('preserves review business wiring while using presentation components', () => {
    expect(source).toContain('persistScanReviewDraftEditorState');
    expect(source).toContain('650');
    expect(source).toContain('beforeRemove');
    expect(source).toContain('saveInFlightRef');
    expect(source).toContain('allowLeaveRef');
    expect(source).toContain('addLineItem');
    expect(source).toContain('removeLineItem');
    expect(source).toContain('finalItemsForSave');
    expect(source).toContain('applyProductIdentityToItem');
    expect(source).toContain('updateLine(idx, { name: v })');
    expect(source).toContain('updateLine(idx, { lineTotal: toNum(v, 0) })');
    expect(source).toContain('onDelete={() => removeLineItem(idx)}');
    expect(source).toContain('onPress={addLineItem}');
  });

  it('keeps the save/cleanup/learning/post-save/navigation order intact', () => {
    const saveIndex = source.indexOf('const receiptId = await saveReceipt');
    const cleanupIndex = source.indexOf(
      'const nextDraftId = await completeSavedDraftAndGetNext'
    );
    const learningIndex = source.indexOf(
      'await applyReviewCorrectionsToLearning'
    );
    const postSaveIndex = source.indexOf(
      'await runPostSaveGrowthAnalysis(receiptId)'
    );
    const summaryNavigationIndex = source.indexOf(
      'buildPostSaveSummaryHref(receiptId, nextDraftId)'
    );

    expect(saveIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(saveIndex);
    expect(learningIndex).toBeGreaterThan(cleanupIndex);
    expect(postSaveIndex).toBeGreaterThan(learningIndex);
    expect(summaryNavigationIndex).toBeGreaterThan(postSaveIndex);
    expect(source).toContain('router.replace(');
    expect(source).toContain('shouldShowLegacyPostSaveEasterEggAlert');
    expect(source).toContain('buildPostSaveSummaryHref');
  });

  it('does not show legacy growth / Price Radar Alerts on Release save path', () => {
    expect(source).toContain('shouldShowLegacyPostSaveEasterEggAlert(__DEV__)');
    const gateIndex = source.indexOf(
      'shouldShowLegacyPostSaveEasterEggAlert(__DEV__)'
    );
    const eggCallIndex = source.indexOf(
      'tryShowNextEasterEgg(allReceipts.length'
    );
    expect(gateIndex).toBeGreaterThan(-1);
    expect(eggCallIndex).toBeGreaterThan(gateIndex);
  });
});

describe('scanReview details component visibility contract', () => {
  it('keeps feedback available to all and OCR/trace behind showDevDetails', () => {
    const details = fs.readFileSync(
      path.resolve(
        __dirname,
        '../components/review/ReceiptReviewDetails.tsx'
      ),
      'utf8'
    );
    expect(details).toContain('scanReview.feedbackToggle');
    expect(details).toContain('RECEIPT_REVIEW_ERROR_TAGS');
    expect(details).toContain('showDevDetails');
    expect(details).toContain('scanReview.traceId');
    expect(details).toContain('scanReview.ocrRawTitle');
    expect(details).toMatch(/\{showDevDetails \? \(/);
  });
});
