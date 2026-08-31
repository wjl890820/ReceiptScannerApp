import * as fs from 'fs';
import * as path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const BANNED_HEX = [
  '#f7f8fa',
  '#1677ff',
  '#15181c',
  '#68707a',
  '#e7e9ec',
  '#d94848',
  '#FFF8EC',
  '#F0C36D',
  '#8A5A00',
];

describe('DS-4 Scan Review presentation contracts', () => {
  const screen = source('app/scan-review/[draftId].tsx');
  const summary = source('components/review/ReceiptSummaryCard.tsx');
  const item = source('components/review/ReceiptItemCard.tsx');
  const saveBar = source('components/review/ReceiptReviewSaveBar.tsx');
  const details = source('components/review/ReceiptReviewDetails.tsx');
  const palette = source('lib/categoryPalette.ts');

  const productionFiles = {
    'app/scan-review/[draftId].tsx': screen,
    'components/review/ReceiptSummaryCard.tsx': summary,
    'components/review/ReceiptItemCard.tsx': item,
    'components/review/ReceiptReviewSaveBar.tsx': saveBar,
    'components/review/ReceiptReviewDetails.tsx': details,
  };

  it('keeps production Screen wired to summary, items, save, image, and navigation', () => {
    expect(screen).toContain('ReceiptSummaryCard');
    expect(screen).toContain('ReceiptItemCard');
    expect(screen).toContain('lineItems.map');
    expect(screen).toContain('ReceiptReviewSaveBar');
    expect(screen).toContain('showDuplicateGate');
    expect(screen).toContain('{!showDuplicateGate ? (');
    expect(saveBar).toContain("position: 'absolute'");
    expect(saveBar).toContain('scanReview.save');
    expect(saveBar).not.toContain('scanReview.addItem');
    expect(screen).toContain('scanReview.back');
    expect(screen).toContain('scanReview.discard');
    expect(screen).toContain('resizeMode="contain"');
    expect(screen).toContain('imageUri');
  });

  it('preserves amountMismatch and dateNeedsConfirm trust signals', () => {
    expect(screen).toContain('amountMismatch={Boolean(snapshot?.amount_mismatch)}');
    expect(screen).toContain('dateNeedsConfirm={reviewDateNeedsConfirm(dateStr, merchant)}');
    expect(summary).toContain('amountMismatch');
    expect(summary).toContain('dateNeedsConfirm');
    expect(summary).toContain('scanReview.amountMismatchWarning');
    expect(summary).toContain('scanReview.dateNeedsConfirm');
  });

  it('preserves add/delete/category/qty/lineTotal callback wiring', () => {
    expect(screen).toContain('onPress={addLineItem}');
    expect(screen).toContain('onDelete={() => removeLineItem(idx)}');
    expect(screen).toContain('onCategoryPress={() => setCategoryModalIndex(idx)}');
    expect(screen).toContain('updateLine(idx, { name: v })');
    expect(screen).toContain('updateLine(idx, { lineTotal: toNum(v, 0) })');
    expect(item).toContain('onQuantityChange');
    expect(item).toContain('onLineTotalChange');
    expect(item).toContain('getCategoryPresentation');
    expect(item).toContain('getCategoryLabel');
  });

  it('keeps feedback collapsed-by-default and gated dev details', () => {
    expect(screen).toContain('ReceiptReviewDetails');
    expect(details).toContain('useState(false)');
    expect(details).toContain('scanReview.feedbackToggle');
    expect(details).toContain('RECEIPT_REVIEW_ERROR_TAGS');
    expect(details).toMatch(/\{showDevDetails \? \(/);
  });

  it('keeps category colors originating from categoryPalette', () => {
    expect(item).toContain("from '@/lib/categoryPalette'");
    expect(item).toContain('categoryPresentation.color');
    expect(palette).toContain('export function getCategoryPresentation');
  });

  it('migrates touched production files onto DS tokens without banned raw hex', () => {
    for (const [file, contents] of Object.entries(productionFiles)) {
      expect(contents).toContain('UI_COLORS');
      for (const hex of BANNED_HEX) {
        expect(`${file} ${contents}`).not.toContain(`'${hex}'`);
        expect(`${file} ${contents}`).not.toContain(`"${hex}"`);
      }
    }
    expect(saveBar).toContain('UI_SHADOW.sticky');
    expect(saveBar).toContain('UI_COLORS.accent');
    expect(summary).toContain('MerunoSurface');
    expect(summary).toContain('TEXT_ROLES.metric');
  });

  it('does not change domain/save/queue modules in DS-4', () => {
    const domainFiles = [
      'lib/db.ts',
      'lib/scanReviewQueue.ts',
      'lib/scanReviewDraftStore.ts',
      'lib/scanReviewDateIsolation.ts',
      'lib/receiptPrintedEvidence.ts',
      'lib/userCorrections.ts',
      'lib/receiptReviewLearning.ts',
      'lib/postSaveGrowthAnalysis.ts',
      'lib/postSaveSummaryNavigation.ts',
    ];
    expect(domainFiles.join('\n')).toContain('scanReviewQueue');
    expect(screen).toContain('saveReceipt');
    expect(screen).toContain('peekNextDraftId');
    expect(screen).toContain('persistScanReviewDraftEditorState');
  });
});
