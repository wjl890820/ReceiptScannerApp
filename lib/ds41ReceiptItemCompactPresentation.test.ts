import * as fs from 'fs';
import * as path from 'path';

import { formatCollapsedLineTotal } from '@/lib/scanReviewPresentation';
import { formatJPY } from '@/lib/formatJPY';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function collapsedBranch(itemSource: string): string {
  const start = itemSource.indexOf('if (!expanded) {');
  const end = itemSource.indexOf('  return (\n    <View style={[styles.row, styles.expandedRow');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return itemSource.slice(start, end);
}

function expandedBranch(itemSource: string): string {
  const start = itemSource.indexOf('  return (\n    <View style={[styles.row, styles.expandedRow');
  const end = itemSource.indexOf('\nconst styles = StyleSheet.create');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return itemSource.slice(start, end);
}

describe('DS-4.1 V2 review row presentation', () => {
  const item = source('components/review/ReceiptItemCard.tsx');
  const screen = source('app/scan-review/[draftId].tsx');
  const collapsed = collapsedBranch(item);
  const expanded = expandedBranch(item);

  it('renders collapsed rows without permanent numeric TextInputs', () => {
    expect(collapsed).not.toContain('keyboardType="number-pad"');
    expect(collapsed).not.toContain('keyboardType="decimal-pad"');
    expect(collapsed).not.toContain('<TextInput');
    expect(item).toContain('const collapsedAmount = formatCollapsedLineTotal(lineTotal, currency)');
    expect(collapsed).toContain('{collapsedAmount}');
  });

  it('renders collapsed rows without a permanent delete action', () => {
    expect(collapsed).not.toContain('onPress={onDelete}');
    expect(collapsed).not.toContain('delete-outline');
    expect(collapsed).not.toContain('deleteItemAction');
  });

  it('presents collapsed name, category, quantity, and subtotal as review metadata', () => {
    expect(collapsed).toContain('styles.collapsedName');
    expect(collapsed).toContain('styles.collapsedAmount');
    expect(collapsed).toContain('categoryPresentation.icon');
    expect(collapsed).toContain('categoryLabel');
    expect(collapsed).toContain("t('scanReview.qtyMeta', { count: quantity })");
    expect(collapsed).toContain('chevron-right');
  });

  it('exposes an accessible expand affordance on collapsed rows', () => {
    expect(collapsed).toContain('onExpand()');
    expect(collapsed).toContain("accessibilityRole=\"button\"");
    expect(collapsed).toContain("t('scanReview.expandItemA11y', { name: displayName })");
    expect(collapsed).toContain('accessibilityState={{ expanded: false }}');
  });

  it('tracks single-item expansion by stable line id in the parent screen', () => {
    expect(screen).toContain('const [expandedItemId, setExpandedItemId] = useState<string | null>(null);');
    expect(screen).toContain('expanded={expandedItemId === line.id}');
    expect(screen).toContain('onExpand={() => setExpandedItemId(line.id)}');
    expect(screen).toContain('onCollapse={() => setExpandedItemId(null)}');
    expect(screen).not.toContain('expandedItemIndex');
  });

  it('exposes the expanded editor with name, category, qty, subtotal, and delete', () => {
    expect(expanded).toContain('onChangeText={onNameChange}');
    expect(expanded).toContain('onPress={onCategoryPress}');
    expect(expanded).toContain('keyboardType="number-pad"');
    expect(expanded).toContain('keyboardType="decimal-pad"');
    expect(expanded).toContain('onPress={onDelete}');
    expect(expanded).toContain("t('scanReview.deleteItemAction')");
    expect(expanded).toContain('onPress={onCollapse}');
  });

  it('keeps expanded numeric TextInputs at >=44pt actual hit height', () => {
    expect(expanded).toContain('style={styles.qtyInput}');
    expect(expanded).toContain('style={styles.lineTotalInput}');
    expect(item).toMatch(/qtyInput:[\s\S]*minHeight: CONTROL_MIN_HEIGHT/);
    expect(item).toMatch(/qtyInput:[\s\S]*height: CONTROL_MIN_HEIGHT/);
    expect(item).toMatch(/lineTotalInput:[\s\S]*minHeight: CONTROL_MIN_HEIGHT/);
    expect(item).toMatch(/lineTotalInput:[\s\S]*height: CONTROL_MIN_HEIGHT/);
    expect(item).not.toMatch(/qtyInput:[\s\S]*minHeight: 20/);
    expect(item).not.toMatch(/lineTotalInput:[\s\S]*minHeight: 22/);
  });

  it('preserves quantity and subtotal editing semantics in expanded mode', () => {
    expect(expanded).toContain('value={String(quantity)}');
    expect(expanded).toContain('onChangeText={onQuantityChange}');
    expect(item).toMatch(/qtyInput:[\s\S]*TEXT_ROLES\.bodySmall/);
    expect(expanded).toContain('value={String(lineTotal)}');
    expect(expanded).toContain('onChangeText={onLineTotalChange}');
    expect(item).toMatch(/lineTotalInput:[\s\S]*TEXT_ROLES\.amount/);
  });

  it('shows recognized-name hint only in expanded mode via existing rules', () => {
    expect(item).toContain('shouldShowRecognizedNameHint(name, recognizedName)');
    expect(collapsed).not.toContain('recognizedNameHint');
    expect(expanded).toContain("t('scanReview.recognizedNameHint', { name: original })");
    expect(expanded).toMatch(/showOriginal && original \? \(/);
  });

  it('collapses without mutating line data and switches expansion by id', () => {
    expect(screen).toContain('onCollapse={() => setExpandedItemId(null)}');
    expect(screen).not.toMatch(/onCollapse=\{[^}]*updateLine/);
    expect(screen).toContain('onExpand={() => setExpandedItemId(line.id)}');
    expect(screen).not.toMatch(/onExpand=\{[^}]*updateLine/);
  });

  it('clears expansion when the expanded item is deleted and expands newly added items', () => {
    expect(screen).toMatch(
      /setExpandedItemId\(\(current\) => \(current === removedId \? null : current\)\)/
    );
    expect(screen).toMatch(/const newId = makeLineId\(\);[\s\S]*setExpandedItemId\(newId\)/);
    expect(screen).toContain('setExpandedItemId(null);');
  });

  it('preserves divider behavior and duplicate gate / save bar contracts', () => {
    expect(item).toContain('showDivider = true');
    expect(item).toContain('showDivider && styles.rowDivider');
    expect(screen).toContain('hideDuplicateGateSaveBar');
    expect(screen).toContain('{!hideDuplicateGateSaveBar ? (');
    expect(screen).toContain('<ReceiptReviewSaveBar');
    expect(screen).toContain('onDelete={() => removeLineItem(idx)}');
    expect(screen).toContain('updateLine(idx, { lineTotal: toNum(v, 0) })');
  });
});

describe('formatCollapsedLineTotal fail-closed presentation', () => {
  it('renders unavailable for non-finite amounts instead of coercing to zero', () => {
    expect(formatCollapsedLineTotal(Number.NaN)).toBe('—');
    expect(formatCollapsedLineTotal(Number.NaN, 'JPY')).toBe('—');
    expect(formatCollapsedLineTotal(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatCollapsedLineTotal(Number.NEGATIVE_INFINITY)).toBe('—');
    expect(formatCollapsedLineTotal(Number.NEGATIVE_INFINITY, 'USD')).toBe('—');
  });

  it('keeps valid finite zero and currency presentations unchanged', () => {
    expect(formatCollapsedLineTotal(0)).toBe(formatJPY(0));
    expect(formatCollapsedLineTotal(0, 'JPY')).toBe(formatJPY(0));
    expect(formatCollapsedLineTotal(429, 'JPY')).toBe(formatJPY(429));
    expect(formatCollapsedLineTotal(1234.5, 'USD')).toBe(
      `USD ${(1234.5).toLocaleString()}`
    );
  });
});
