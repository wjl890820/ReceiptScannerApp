import * as fs from 'fs';
import * as path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('Build 58 Phase 1 interaction language', () => {
  it('uses a deterministic generic storefront merchant identity', () => {
    const tile = source('components/MerchantIdentityTile.tsx');
    expect(tile).toContain('merchantAccentColor(');
    expect(tile).toContain('name="storefront"');
    expect(tile).not.toContain('merchantIdentityGlyph');
    expect(tile).not.toMatch(/<Text[\s>]/);
  });

  it('defines shared grouped rows, category icons, and disclosure variants', () => {
    const grouped = source('components/MerunoGroupedList.tsx');
    const category = source('components/CategoryIdentityIcon.tsx');
    const disclosure = source('components/MerunoDisclosureIndicator.tsx');

    expect(grouped).toContain('export function MerunoGroupedList');
    expect(grouped).toContain('export function MerunoGroupedRow');
    expect(grouped).toContain('pressed && styles.rowPressed');
    expect(category).toContain('export function CategoryIdentityIcon');
    expect(disclosure).toContain("'none' | 'crossEntity' | 'settings'");
    expect(disclosure).toContain('width: 28');
    expect(disclosure).toContain('backgroundColor: UI_COLORS.accentSoft');
    expect(disclosure).toContain('size={14}');
  });

  it('keeps month grouping while removing generic receipt-row chevrons', () => {
    const history = source('app/(tabs)/history/index.tsx');

    expect(history).toContain('buildHistoryMonthSections');
    expect(history).toContain('<MerunoGroupedList>');
    expect(history).toContain('<MerunoGroupedRow');
    expect(history).toContain('minHeight={92}');
    expect(history).toContain('kind="crossEntity"');
    expect(history).not.toContain('<IconSymbol name="chevron.right"');
    expect(history).not.toContain('color="#999"');
  });

  it('preserves History purchase truth and navigation handlers', () => {
    const history = source('app/(tabs)/history/index.tsx');

    expect(history).toContain('buildHistoryPurchaseTruthView');
    expect(history).toContain('projectHistorySearchToPurchaseTruth');
    expect(history).toContain('expandHistoryPurchaseDeleteIds');
    expect(history).toContain('router.push(`/history/${item.id}`)');
  });
});
