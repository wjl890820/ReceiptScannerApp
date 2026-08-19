import {
  isReviewDateUnknown,
  resolveInitialReviewDateStr,
  reviewDateNeedsConfirm,
} from './scanReviewDateIsolation';

describe('Sample 087 review date isolation', () => {
  it('Receipt B with null OCR date → unknown (not previous receipt date)', () => {
    const receiptADate = '2026-08-01 11:22';
    expect(
      resolveInitialReviewDateStr({
        snapshotTransactionDate: receiptADate,
      })
    ).toBe(receiptADate);

    expect(
      resolveInitialReviewDateStr({
        snapshotTransactionDate: null,
      })
    ).toBe('');
    expect(isReviewDateUnknown('')).toBe(true);
  });

  it('new draft without editorState never inherits a prior dateStr', () => {
    const priorEditorDate = '2026-08-01 11:22';
    expect(
      resolveInitialReviewDateStr({
        editorState: undefined,
        snapshotTransactionDate: undefined,
      })
    ).toBe('');
    expect(
      resolveInitialReviewDateStr({
        snapshotTransactionDate: null,
      })
    ).not.toBe(priorEditorDate);
  });

  it('editorState on same draft restores user-edited date only', () => {
    expect(
      resolveInitialReviewDateStr({
        editorState: {
          version: 1,
          merchant: '',
          dateStr: '2026-07-23 11:06:40',
          totalStr: '1000',
          taxStr: '',
          currency: 'JPY',
          note: '',
          lineItems: [],
          errorTags: [],
        },
        snapshotTransactionDate: null,
      })
    ).toBe('2026-07-23 11:06:40');
  });

  it('async draft boundary: empty snapshot date stays unknown even if prior date exists elsewhere', () => {
    const priorReceiptDate = '2026-08-01 11:22';
    const nextDraftDate = resolveInitialReviewDateStr({
      snapshotTransactionDate: '',
    });
    expect(nextDraftDate).toBe('');
    expect(nextDraftDate).not.toBe(priorReceiptDate);
  });
});

describe('reviewDateNeedsConfirm: CASE 1 Costco merchant context', () => {
  it('Costco + 06/10/2026 10:50:58 does not need confirm', () => {
    expect(reviewDateNeedsConfirm('06/10/2026 10:50:58', 'コストコ')).toBe(false);
    expect(reviewDateNeedsConfirm('06/10/2026 10:50:58', 'Costco')).toBe(false);
  });

  it('Costco + 07/06/2023 11:44:46 does not need confirm', () => {
    expect(reviewDateNeedsConfirm('07/06/2023 11:44:46', 'コストコ')).toBe(false);
    expect(reviewDateNeedsConfirm('07/06/2023 11:44:46', 'Costco')).toBe(false);
  });

  it('same MDY without merchant still needs confirm', () => {
    expect(reviewDateNeedsConfirm('06/10/2026 10:50:58', '')).toBe(true);
    expect(reviewDateNeedsConfirm('07/06/2023 11:44:46', 'イオン')).toBe(true);
  });

  it('empty date still needs confirm even with Costco merchant', () => {
    expect(reviewDateNeedsConfirm('', 'コストコ')).toBe(true);
    expect(reviewDateNeedsConfirm(null, 'コストコ')).toBe(true);
  });
});
