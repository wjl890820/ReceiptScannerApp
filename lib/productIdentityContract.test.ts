import * as fs from 'fs';
import * as path from 'path';

import { resolveProductIdentity } from './productIdentity';
import {
  PRODUCT_IDENTITY_CONTRACT_VERSION,
  PRODUCT_IDENTITY_LEVELS,
  PRODUCT_IDENTITY_RESOLVER_VERSION,
  assertValidReceiptItemIdentityLink,
  buildProductAttributes,
  buildReceiptItemIdentityLinkFromLegacy,
  clampIdentityConfidence,
  deriveIdentityLevelFromLegacyProductIdentity,
  emptyProductAttributes,
  isProductIdentityLevel,
  productAttributesFromSpecification,
  unresolvedReceiptItemIdentityLink,
} from './productIdentityContract';
import {
  PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL,
  ensureProductIdentityEntitySchema,
} from './productIdentityEntitySchema';
import { parseProductSpecification } from './productSpecification';

describe('productIdentityContract (Batch 1)', () => {
  describe('identity levels', () => {
    it('accepts every declared identity level', () => {
      for (const level of PRODUCT_IDENTITY_LEVELS) {
        expect(isProductIdentityLevel(level)).toBe(true);
      }
    });

    it('rejects unknown levels', () => {
      expect(isProductIdentityLevel('sku')).toBe(false);
      expect(isProductIdentityLevel('')).toBe(false);
      expect(isProductIdentityLevel(null)).toBe(false);
    });
  });

  describe('confidence', () => {
    it('clamps to [0, 1]', () => {
      expect(clampIdentityConfidence(-0.5)).toBe(0);
      expect(clampIdentityConfidence(0)).toBe(0);
      expect(clampIdentityConfidence(0.42)).toBe(0.42);
      expect(clampIdentityConfidence(1)).toBe(1);
      expect(clampIdentityConfidence(1.5)).toBe(1);
      expect(clampIdentityConfidence(Number.NaN)).toBe(0);
      expect(clampIdentityConfidence('0.9')).toBe(0);
    });
  });

  describe('unresolved / null entity ids', () => {
    it('unresolved link is legal with null SKU and null canonical', () => {
      const link = unresolvedReceiptItemIdentityLink();
      expect(link.identityLevel).toBe('unresolved');
      expect(link.merchantProductId).toBeNull();
      expect(link.canonicalProductId).toBeNull();
      expect(link.skuId).toBeNull();
      expect(link.resolverVersion).toBe(PRODUCT_IDENTITY_RESOLVER_VERSION);
      expect(() => assertValidReceiptItemIdentityLink(link)).not.toThrow();
    });

    it('assertValid rejects missing resolverVersion and bad confidence', () => {
      expect(() =>
        assertValidReceiptItemIdentityLink({
          ...unresolvedReceiptItemIdentityLink(),
          resolverVersion: '',
        })
      ).toThrow(/resolverVersion/);

      expect(() =>
        assertValidReceiptItemIdentityLink({
          ...unresolvedReceiptItemIdentityLink(),
          identityConfidence: 2,
        })
      ).toThrow(/identityConfidence/);
    });
  });

  describe('dynamic attributes (no product-specific columns)', () => {
    it('represents 牛奶 1000ml via volume attribute', () => {
      const attrs = buildProductAttributes([
        { dimension: 'volume', value: 1000, unit: 'ml', confidence: 1 },
      ]);
      expect(attrs.version).toBe('product-attributes-v1');
      expect(attrs.entries).toEqual([
        expect.objectContaining({ dimension: 'volume', value: 1000, unit: 'ml' }),
      ]);
    });

    it('represents 米 5kg via mass attribute', () => {
      const attrs = buildProductAttributes([
        { dimension: 'mass', value: 5, unit: 'kg', confidence: 1 },
      ]);
      expect(attrs.entries[0]).toMatchObject({
        dimension: 'mass',
        value: 5,
        unit: 'kg',
      });
    });

    it('represents 電池 8本 via count attribute', () => {
      const attrs = buildProductAttributes([
        { dimension: 'count', value: 8, unit: 'count', source: '8本' },
      ]);
      expect(attrs.entries[0]).toMatchObject({
        dimension: 'count',
        value: 8,
      });
    });

    it('represents USB cable 2m via length attribute', () => {
      const attrs = buildProductAttributes([
        { dimension: 'length', value: 2, unit: 'm', confidence: 0.9 },
      ]);
      expect(attrs.entries[0]).toMatchObject({
        dimension: 'length',
        value: 2,
        unit: 'm',
      });
    });

    it('represents トイレットペーパー 12 rolls without a rolls column', () => {
      const attrs = buildProductAttributes([
        { dimension: 'roll_count', value: 12, unit: 'roll', confidence: 1 },
        { dimension: 'ply', value: 2, unit: null, confidence: 0.5 },
      ]);
      expect(attrs.entries.map((e) => e.dimension).sort()).toEqual([
        'ply',
        'roll_count',
      ]);
    });

    it('maps ProductSpecification into generic attributes', () => {
      const spec = parseProductSpecification('明治おいしい牛乳 1000ml');
      const attrs = productAttributesFromSpecification(spec);
      expect(attrs.entries.some((e) => e.dimension === 'volume')).toBe(true);
      expect(emptyProductAttributes().entries).toEqual([]);
    });
  });

  describe('legacy ProductIdentity → contract link (advisory only)', () => {
    it('does not invent entity ids when projecting legacy identity', () => {
      const identity = resolveProductIdentity({ rawName: '明治おいしい牛乳 1000ml' });
      const link = buildReceiptItemIdentityLinkFromLegacy(identity);
      expect(link.merchantProductId).toBeNull();
      expect(link.canonicalProductId).toBeNull();
      expect(PRODUCT_IDENTITY_LEVELS as readonly string[]).toContain(
        link.identityLevel
      );
      expect(link.identityConfidence).toBeGreaterThanOrEqual(0);
      expect(link.identityConfidence).toBeLessThanOrEqual(1);
      expect(link.resolverVersion).toBe(PRODUCT_IDENTITY_RESOLVER_VERSION);
    });

    it('unknown free text stays without SKU id', () => {
      const identity = resolveProductIdentity({
        rawName: 'あいうえお完全未知商品XYZ',
      });
      const level = deriveIdentityLevelFromLegacyProductIdentity(identity);
      expect(PRODUCT_IDENTITY_LEVELS as readonly string[]).toContain(level);
      const link = buildReceiptItemIdentityLinkFromLegacy(identity);
      expect(link.skuId).toBeNull();
    });

    it('skuKey elevates to sku_exact without requiring JAN', () => {
      const identity = resolveProductIdentity({ rawName: '何か' });
      const level = deriveIdentityLevelFromLegacyProductIdentity(identity, {
        skuKey: 'merchant:sku:1',
      });
      expect(level).toBe('sku_exact');
    });
  });

  describe('contract constants', () => {
    it('exposes stable contract + resolver version stamps', () => {
      expect(PRODUCT_IDENTITY_CONTRACT_VERSION).toBe(
        'meruno-product-identity-contract-v1'
      );
      expect(PRODUCT_IDENTITY_RESOLVER_VERSION).toContain('resolver');
    });
  });
});

describe('productIdentityEntitySchema (Batch 1 additive)', () => {
  it('CREATE TABLE IF NOT EXISTS is idempotent and creates entity tables', async () => {
    const executed: string[] = [];
    const db = {
      execAsync: async (source: string) => {
        executed.push(source);
      },
    };
    await ensureProductIdentityEntitySchema(db);
    await ensureProductIdentityEntitySchema(db);
    expect(executed).toHaveLength(2);
    expect(PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL).toContain('merchant_products');
    expect(PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL).toContain('canonical_products');
    expect(PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL).toContain('product_variants');
    expect(PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL).toContain('attributes_json');
    expect(PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL).toMatch(/jan_code TEXT/);
  });
});

describe('Batch 1 freeze — no live enrichment wiring', () => {
  it('contract module does not import OCR / generative AI / price history', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'productIdentityContract.ts'),
      'utf8'
    );
    // Ignore block comments; assert against import / code surface only.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/from ['"].*(ocr|gemini|openai|productPriceHistory)/i);
    expect(code).not.toMatch(/Levenshtein|embedding/i);
  });
});
