import * as fs from 'fs';
import * as path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('DS-2 shared component visual contracts', () => {
  it('keeps MerunoGroupedRow list press as surface wash, not MerunoPressable opacity', () => {
    const grouped = source('components/MerunoGroupedList.tsx');

    expect(grouped).toContain('pressed && styles.rowPressed');
    expect(grouped).toContain('backgroundColor: UI_COLORS.surfaceMuted');
    expect(grouped).not.toContain('MerunoPressable');
    expect(grouped).toContain('UI_OPACITY.disabled');
    expect(grouped).toContain('if (!onPress)');
    expect(grouped).toContain('children({ pressed })');
    expect(grouped).toContain('minHeight = 92');
  });

  it('preserves MerunoDisclosureIndicator kinds and distinct semantics', () => {
    const disclosure = source('components/MerunoDisclosureIndicator.tsx');

    expect(disclosure).toContain("kind === 'settings'");
    expect(disclosure).toContain("kind === 'none'");
    expect(disclosure).toContain('name="chevron-right"');
    expect(disclosure).toContain('name="arrow-forward"');
    expect(disclosure).toContain('importantForAccessibility="no"');
    expect(disclosure).toContain('accessibilityElementsHidden');
    expect(disclosure).not.toMatch(/['"]#1677ff['"]/);
  });

  it('keeps MerchantIdentityTile merchant accent algorithm untouched', () => {
    const tile = source('components/MerchantIdentityTile.tsx');

    expect(tile).toContain('merchantAccentColor(');
    expect(tile).toContain('normalizeMerchantName(');
    expect(tile).toContain('merchantKey ??');
    expect(tile).toContain('name="storefront"');
    expect(tile).toContain('UI_COLORS.surface');
    expect(tile).not.toContain('#FFFFFF');
    expect(tile).not.toContain('categoryPalette');
  });

  it('converges milestone progress components on shared accent fill and DS track', () => {
    const card = source('components/MilestoneProgressCard.tsx');
    const progress = source('components/MilestoneProgress.tsx');
    const visual = source('lib/milestoneProgressVisual.ts');

    for (const file of [card, progress]) {
      expect(file).toContain('milestoneProgressVisual');
      expect(file).not.toMatch(/['"]#1677ff['"]/);
      expect(file).not.toContain("backgroundColor: '#222'");
    }

    expect(visual).toContain('MILESTONE_PROGRESS_TRACK_HEIGHT = 7');
    expect(visual).toContain('backgroundColor: UI_COLORS.accent');
    expect(card).toContain('tone="accent"');
    expect(progress).toContain('tone="accent"');
    expect(card).toContain('MerunoText');
    expect(progress).toContain('MerunoText');
  });

  it('preserves milestone domain branches and i18n keys', () => {
    const card = source('components/MilestoneProgressCard.tsx');
    const progress = source('components/MilestoneProgress.tsx');
    const unlock = source('components/MilestoneUnlockCard.tsx');

    expect(card).toContain('home.progressive.progress.unlockRecent');
    expect(card).toContain('home.progressive.progress.unlockFrequent');
    expect(card).toContain('home.progressive.progress.unlockProfile');
    expect(card).toContain('status.nextMilestone === 3');
    expect(card).toContain('status.supportedReceiptCount / status.nextMilestone');

    expect(progress).toContain('postSaveSummary.progress.unlockRecent');
    expect(progress).toContain('viewModel.profileEstablished');
    expect(progress).toContain(
      'viewModel.supportedReceiptCount / viewModel.nextMilestone'
    );

    expect(unlock).toContain('postSaveSummary.unlock.first');
    expect(unlock).toContain('postSaveSummary.unlock.third');
    expect(unlock).toContain('postSaveSummary.unlock.fifth');
    expect(unlock).toContain('postSaveSummary.unlock.tenth');
    expect(unlock).toContain('formatFrequentProductLabel');
    expect(unlock).toContain('purchaseOccurrenceCount');
    expect(unlock).toContain('priceSummary');
  });

  it('normalizes milestone unlock surfaces without charcoal hero card', () => {
    const unlock = source('components/MilestoneUnlockCard.tsx');

    expect(unlock).toContain('UI_RADIUS.card');
    expect(unlock).toContain('UI_COLORS.surfaceMuted');
    expect(unlock).toContain('UI_COLORS.charcoal');
    expect(unlock).not.toMatch(/borderRadius:\s*16/);
    expect(unlock).not.toMatch(/backgroundColor:\s*['"]#ececec['"]/);
    expect(unlock).not.toMatch(/backgroundColor:\s*['"]#fff['"]/);
    expect(unlock).not.toMatch(/backgroundColor:\s*['"]#f3f3f3['"]/);
    expect(unlock).toContain('backgroundColor: UI_COLORS.surfaceMuted');
    expect(unlock).toMatch(/badge:[\s\S]*backgroundColor: UI_COLORS\.charcoal/);
  });

  it('does not touch screen routes in DS-2', () => {
    const screens = [
      'app/(tabs)/index.tsx',
      'app/(tabs)/analysis.tsx',
      'app/(tabs)/history/index.tsx',
      'app/(tabs)/history/[id].tsx',
      'app/product/[targetType].tsx',
      'app/scan-review/[draftId].tsx',
      'app/post-save-summary/[receiptId].tsx',
    ];

    for (const screen of screens) {
      const contents = source(screen);
      expect(contents).not.toContain('milestoneProgressVisual');
    }
  });
});
