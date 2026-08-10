/**
 * Known issue regression: normalizeReceiptItemName spec extraction after unit strip.
 * Phase 2 will fix via productIdentity (extract spec before normalize).
 * DO NOT "fix" in Phase 1 — this test documents current behavior.
 */

import { normalizeReceiptItemName } from './productNormalizer';

describe('productNormalizer spec known issue (Phase 2)', () => {
  it('明治ｵｲｼｲ牛乳900ML: spec 可能因先 strip 单位而丢失', () => {
    const result = normalizeReceiptItemName('明治ｵｲｼｲ牛乳900ML');
    // 当前行为：normalizeProductName 先移除 900ML，后续 SPEC_PATTERNS 无法匹配
    expect(result.spec?.size_value).toBeUndefined();
    expect(result.spec?.size_unit).toBeUndefined();
    expect(result.normalized_name).not.toContain('900');
  });
});
