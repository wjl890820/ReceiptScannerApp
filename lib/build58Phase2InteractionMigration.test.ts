import * as fs from 'fs';
import * as path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('Build 58 Phase 2 interaction migration', () => {
  it('gives Receipt separate edit and cross-entity product affordances', () => {
    const receipt = source('app/(tabs)/history/[id].tsx');

    expect(receipt).toContain('<MerunoGroupedList>');
    expect(receipt).toContain('<MerunoGroupedRow');
    expect(receipt).toContain('<CategoryIdentityIcon');
    expect(receipt).toContain('kind="crossEntity"');
    expect(receipt).toContain('openItemEditor(idx)');
    expect(receipt).toContain('router.push(productHref as Href)');
    expect(receipt).not.toContain('<IconSymbol');
    expect(receipt).not.toContain('name="chevron.right"');
  });

  it('keeps Product stores informational and purchase records navigable', () => {
    const product = source('app/product/[targetType].tsx');
    const storesStart = product.indexOf(
      "<SectionTitle title={t('productDetail.stores')} />"
    );
    const recordsStart = product.indexOf(
      "<SectionTitle title={t('productDetail.recentPurchases')} />"
    );
    const storesRegion = product.slice(storesStart, recordsStart);
    const recordsRegion = product.slice(recordsStart);

    expect(storesRegion).toContain('<MerchantIdentityTile');
    expect(storesRegion).toContain('<MerunoGroupedRow');
    expect(storesRegion).not.toContain('onPress=');
    expect(storesRegion).not.toContain('MerunoDisclosureIndicator');
    expect(recordsRegion).toContain('router.push(`/history/${purchase.receiptId}`)');
    expect(recordsRegion).toContain('kind="crossEntity"');
    expect(product).not.toContain('<IconSymbol');
  });

  it('uses quiet Settings disclosure and hides it for account actions', () => {
    const settings = source('app/(tabs)/settings/index.tsx');
    const disclosure = source('components/MerunoDisclosureIndicator.tsx');

    expect(settings).toContain('<MerunoGroupedRow');
    expect(settings).toContain("kind={showDisclosure ? 'settings' : 'none'}");
    expect(settings.match(/showDisclosure=\{false\}/g)).toHaveLength(3);
    expect(settings).not.toContain('<Text style={styles.chevron}>');
    expect(disclosure).toContain('size={14}');
  });

  it('keeps static grouped information rows non-pressable', () => {
    const grouped = source('components/MerunoGroupedList.tsx');

    expect(grouped).toContain('if (!onPress)');
    expect(grouped).toContain('{content(false)}');
    expect(grouped).toContain('pressed && styles.rowPressed');
  });

  it('preserves detail stack and dirty-review navigation contracts', () => {
    expect(source('app/(tabs)/history/_layout.tsx')).toContain(
      'gestureEnabled: true'
    );
    expect(source('app/(tabs)/settings/_layout.tsx')).toContain(
      'gestureEnabled: true'
    );
    expect(source('app/_layout.tsx')).toContain('gestureEnabled: true');
    expect(source('app/scan-review/[draftId].tsx')).toContain(
      "navigation.addListener('beforeRemove'"
    );
  });
});
