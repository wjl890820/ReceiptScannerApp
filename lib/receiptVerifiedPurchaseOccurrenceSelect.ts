/**
 * Shared SELECT fragment for the verified purchase-occurrence bundle.
 * Readers that supply purchase truth must project all three columns together.
 */

const VERIFIED_PURCHASE_OCCURRENCE_FIELDS = [
  'verified_purchase_occurrence_id',
  'verified_purchase_occurrence_source',
  'verified_purchase_occurrence_verified_at',
] as const;

export function verifiedPurchaseOccurrenceColumnsSql(qualifier?: string): string {
  const prefix = qualifier ? `${qualifier}.` : '';
  return VERIFIED_PURCHASE_OCCURRENCE_FIELDS.map((field) => `${prefix}${field}`).join(
    ', '
  );
}

export function verifiedPurchaseOccurrenceAliasedColumnsSql(qualifier: string): string {
  const prefix = `${qualifier}.`;
  return [
    `${prefix}verified_purchase_occurrence_id AS verifiedPurchaseOccurrenceId`,
    `${prefix}verified_purchase_occurrence_source AS verifiedPurchaseOccurrenceSource`,
    `${prefix}verified_purchase_occurrence_verified_at AS verifiedPurchaseOccurrenceVerifiedAt`,
  ].join(', ');
}
