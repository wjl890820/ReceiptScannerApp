import { applyProductIdentityToItem } from './receiptItemIdentity';
import { normalizeReceiptItemName } from './productNormalizer';

describe('applyProductIdentityToItem', () => {
  it('persists identity for a normal scanned milk item without changing legacy keys', () => {
    const rawName = '明治ｵｲｼｲ牛乳900ML';
    const item = {
      name: rawName,
      category: 'food_ingredients',
      normalized_name: normalizeReceiptItemName(rawName).normalized_name,
      canonical_name: 'legacy-canonical-value',
      quantity: 1,
    };

    const got = applyProductIdentityToItem(item, {
      finalName: rawName,
      finalCategory: item.category,
    });

    expect(got.normalized_name).toBe(
      normalizeReceiptItemName(rawName).normalized_name
    );
    expect(got.canonical_name).toBe('legacy-canonical-value');
    expect(got.normalized_full_name).toBe('明治オイシイ牛乳900ml');
    expect(got.canonical_product_name).toBe('明治 おいしい牛乳');
    expect(got.brand).toBe('明治');
    expect(got.product_family_key).toBe('milk');
    expect(got.spec_size_value).toBe(900);
    expect(got.spec_size_unit).toBe('ml');
    expect(got.spec_pack_count).toBe(1);
    expect(got.volume_base_ml).toBe(900);
    expect(got.identity_version).toBe(1);
  });

  it('persists explicit nulls for an unknown specification', () => {
    const got = applyProductIdentityToItem({
      name: '午後の紅茶 500',
      category: 'snacks_drinks',
    });

    expect(got.product_family_key).toBe('tea');
    expect(got.spec_size_value).toBeNull();
    expect(got.spec_size_unit).toBeNull();
    expect(got.spec_pack_count).toBeNull();
    expect(got.volume_base_ml).toBeNull();
    expect(got.weight_base_g).toBeNull();
    expect(got.count_base).toBeNull();
    expect(got.spec_source_text).toBeNull();
  });

  it('persists multipack semantics without folding into sizeValue', () => {
    const got = applyProductIdentityToItem({
      name: '水 500ml×6本',
      category: 'snacks_drinks',
    });

    expect(got.product_family_key).toBe('water');
    expect(got.spec_size_value).toBe(500);
    expect(got.spec_size_unit).toBe('ml');
    expect(got.spec_pack_count).toBe(6);
    expect(got.volume_base_ml).toBe(3000);
  });

  it('recomputes stale review identity from the final renamed item', () => {
    const stale = applyProductIdentityToItem({
      name: '明治 おいしい牛乳 900ml',
      category: 'food_ingredients',
    });

    const got = applyProductIdentityToItem(
      {
        ...stale,
        name: '明治 おいしい牛乳 450ml',
      },
      {
        finalName: '明治 おいしい牛乳 450ml',
        finalCategory: 'food_ingredients',
        useExistingClassificationEvidence: false,
      }
    );

    expect(got.spec_size_value).toBe(450);
    expect(got.volume_base_ml).toBe(450);
    expect(got.canonical_product_name).toBe('明治 おいしい牛乳');
    expect(got.identity_source).toBe('high_confidence_rule');
  });

  it('adds complete identity to a user-added count item', () => {
    const got = applyProductIdentityToItem(
      {
        name: '卵10個',
        category: 'food_ingredients',
        quantity: 1,
      },
      {
        finalName: '卵10個',
        finalCategory: 'food_ingredients',
      }
    );

    expect(got.normalized_name).toBe(
      normalizeReceiptItemName('卵10個').normalized_name
    );
    expect(got.product_family_key).toBe('eggs');
    expect(got.spec_size_unit).toBe('count');
    expect(got.spec_pack_count).toBe(1);
    expect(got.count_base).toBe(10);
  });

  it('uses final category as evidence but never overwrites user category', () => {
    const got = applyProductIdentityToItem(
      {
        name: '牛乳 900ml',
        category: 'household',
      },
      {
        finalName: '牛乳 900ml',
        finalCategory: 'household',
      }
    );

    expect(got.category).toBe('household');
    expect(got.product_family_key).toBeNull();
  });

  it('does not multiply package specification by receipt purchase quantity', () => {
    const one = applyProductIdentityToItem({
      name: '明治 おいしい牛乳 900ml',
      category: 'food_ingredients',
      quantity: 1,
    });
    const two = applyProductIdentityToItem({
      name: '明治 おいしい牛乳 900ml',
      category: 'food_ingredients',
      quantity: 2,
    });

    expect(one.volume_base_ml).toBe(900);
    expect(two.volume_base_ml).toBe(900);
  });

  it('prefers a trusted classification brand over rule-derived brand', () => {
    const got = applyProductIdentityToItem(
      {
        name: '明治 おいしい牛乳 900ml',
        category: 'food_ingredients',
      },
      {
        classificationBrand: 'Trusted Dictionary Brand',
      }
    );
    expect(got.brand).toBe('Trusted Dictionary Brand');
  });

  it('persists BOSS weight candidate without creating price or SKU fields', () => {
    const got = applyProductIdentityToItem({
      name: 'BOSS 185g',
      category: 'snacks_drinks',
    });
    expect(got.product_family_key).toBe('coffee');
    expect(got.spec_size_unit).toBe('g');
    expect(got.weight_base_g).toBe(185);
    expect(got).not.toHaveProperty('yen_per_100g');
    expect(got).not.toHaveProperty('sku_key');
  });
});
