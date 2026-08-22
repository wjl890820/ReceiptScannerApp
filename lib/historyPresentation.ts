/**
 * History list / search presentation helpers (R2-B4).
 *
 * UI-only. Does not change search matching, ranking, merchant identity,
 * product identity, or delete semantics.
 */

export type HistoryMerchantDisplaySource = {
  merchant_raw?: string | null;
  merchant_normalized?: string | null;
  merchantRaw?: string | null;
  merchantNormalized?: string | null;
};

/** Merchant display contract: raw || normalized (never analytics keys). */
export function formatHistoryMerchantDisplay(
  source: HistoryMerchantDisplaySource,
  unknownLabel: string
): string {
  const raw =
    (typeof source.merchant_raw === 'string' && source.merchant_raw.trim()) ||
    (typeof source.merchantRaw === 'string' && source.merchantRaw.trim()) ||
    '';
  if (raw) return raw;
  const normalized =
    (typeof source.merchant_normalized === 'string' &&
      source.merchant_normalized.trim()) ||
    (typeof source.merchantNormalized === 'string' &&
      source.merchantNormalized.trim()) ||
    '';
  return normalized || unknownLabel;
}

export type HistorySearchSectionKind = 'products' | 'receipts';

export type HistorySearchSectionSpec = {
  kind: HistorySearchSectionKind;
  title: string;
};

/**
 * Build search section headers in stable order: products then receipts.
 * Empty collections are omitted — matching/ranking stay with search helpers.
 */
export function buildHistorySearchSectionSpecs(options: {
  productCount: number;
  receiptCount: number;
  productsTitle: string;
  receiptsTitle: string;
}): HistorySearchSectionSpec[] {
  const sections: HistorySearchSectionSpec[] = [];
  if (options.productCount > 0) {
    sections.push({ kind: 'products', title: options.productsTitle });
  }
  if (options.receiptCount > 0) {
    sections.push({ kind: 'receipts', title: options.receiptsTitle });
  }
  return sections;
}

export function buildHistoryReceiptRowA11yLabel(options: {
  merchant: string;
  dateLine: string;
  totalLabel: string;
}): string {
  return [options.merchant, options.dateLine, options.totalLabel]
    .filter((part) => part.trim().length > 0)
    .join(', ');
}

export function buildHistorySelectModeSubtitle(options: {
  selectMode: boolean;
  selectedCount: number;
  defaultSubtitle: string;
  selectingSubtitle: string;
}): string {
  if (!options.selectMode) return options.defaultSubtitle;
  return options.selectingSubtitle.replace(
    '{count}',
    String(options.selectedCount)
  );
}
