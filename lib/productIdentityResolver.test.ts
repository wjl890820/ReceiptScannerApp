/**
 * Product Identity Batch 3 — resolver / conflict / stale-link tests.
 */

import {
  FUZZY_AUTO_MATCH_THRESHOLD,
  resolveReceiptItemIdentity,
} from './productIdentityResolver';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import {
  attributesAreCompatible,
  findStructuralConflicts,
} from './productIdentityStructuralConflict';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import { buildItemIdentityFingerprint } from './productIdentityFingerprint';
import {
  PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL,
  ensureProductIdentityEntitySchema,
} from './productIdentityEntitySchema';
import {
  observationsFromProductIntelligenceExport,
  runShadowIdentityAudit,
} from './productIdentityShadowAudit';

describe('Product Identity Batch 3 — structural conflicts', () => {
  it('rejects volume conflict 500ml vs 1.5L', () => {
    const a = normalizeProductForIdentity('コーラ500ml');
    const b = normalizeProductForIdentity('コーラ1.5L');
    const conflicts = findStructuralConflicts(a.attributes, b.attributes);
    expect(conflicts.some((c) => c.kind === 'volume')).toBe(true);
    expect(attributesAreCompatible(a.attributes, b.attributes).ok).toBe(false);
  });

  it('rejects multipack 500ml×6 vs 3L even if totals match', () => {
    const a = normalizeProductForIdentity('500ml×6本');
    const b = normalizeProductForIdentity('3L');
    const conflicts = findStructuralConflicts(a.attributes, b.attributes);
    expect(
      conflicts.some(
        (c) => c.kind === 'volume' || c.kind === 'pack_structure'
      )
    ).toBe(true);
  });

  it('rejects milk tea vs lemon tea variant tokens', () => {
    const left = '午後の紅茶 ミルクティー500ml';
    const right = '午後の紅茶 レモンティー500ml';
    const a = normalizeProductForIdentity(left);
    const b = normalizeProductForIdentity(right);
    const compat = attributesAreCompatible(
      a.attributes,
      b.attributes,
      left,
      right
    );
    expect(compat.ok).toBe(false);
    expect(compat.conflicts.some((c) => c.kind === 'variant_token')).toBe(true);
  });

  it('rejects ZERO variant', () => {
    const left = 'コカコーラ500ml';
    const right = 'コカコーラZERO500ml';
    const a = normalizeProductForIdentity(left);
    const b = normalizeProductForIdentity(right);
    const compat = attributesAreCompatible(
      a.attributes,
      b.attributes,
      left,
      right
    );
    expect(compat.ok).toBe(false);
  });
});

describe('Product Identity Batch 3 — resolver', () => {
  it(`documents fuzzy auto-match threshold = ${FUZZY_AUTO_MATCH_THRESHOLD}`, () => {
    expect(FUZZY_AUTO_MATCH_THRESHOLD).toBeGreaterThanOrEqual(0.97);
  });

  it('exact same merchant milk variants share MerchantProduct', () => {
    const store = createMemoryProductIdentityStore();
    const a = resolveReceiptItemIdentity(
      {
        rawName: '東北恵牛乳1L',
        merchantKey: 'ヨークベニマル',
        receiptId: 'r1',
        itemSourceIndex: 0,
      },
      store
    );
    const b = resolveReceiptItemIdentity(
      {
        rawName: '東北恵 牛乳１０００ＭＬ',
        merchantKey: 'ヨークベニマル',
        receiptId: 'r2',
        itemSourceIndex: 0,
      },
      store
    );
    expect(a.link.merchantProductId).toBeTruthy();
    expect(b.link.merchantProductId).toBe(a.link.merchantProductId);
    expect(a.link.identityLevel).not.toBe('unresolved');
    expect(b.link.skuId).toBeNull();
  });

  it('does not auto-merge structural volume conflict', () => {
    const store = createMemoryProductIdentityStore();
    const a = resolveReceiptItemIdentity(
      { rawName: 'コーラ500ml', merchantKey: 'm1', receiptId: 'r1', itemSourceIndex: 0 },
      store
    );
    const b = resolveReceiptItemIdentity(
      { rawName: 'コーラ1.5L', merchantKey: 'm1', receiptId: 'r2', itemSourceIndex: 0 },
      store
    );
    expect(a.link.merchantProductId).not.toBe(b.link.merchantProductId);
  });

  it('does not auto-merge multipack vs bulk volume', () => {
    const store = createMemoryProductIdentityStore();
    const a = resolveReceiptItemIdentity(
      { rawName: 'コーラ500ml×6本', merchantKey: 'm1', receiptId: 'r1', itemSourceIndex: 0 },
      store
    );
    const b = resolveReceiptItemIdentity(
      { rawName: 'コーラ3L', merchantKey: 'm1', receiptId: 'r2', itemSourceIndex: 0 },
      store
    );
    expect(a.link.merchantProductId).not.toBe(b.link.merchantProductId);
  });

  it('does not merge milk tea vs lemon tea', () => {
    const store = createMemoryProductIdentityStore();
    const a = resolveReceiptItemIdentity(
      {
        rawName: '午後の紅茶 ミルクティー500ml',
        merchantKey: 'm1',
        receiptId: 'r1',
        itemSourceIndex: 0,
      },
      store
    );
    const b = resolveReceiptItemIdentity(
      {
        rawName: '午後の紅茶 レモンティー500ml',
        merchantKey: 'm1',
        receiptId: 'r2',
        itemSourceIndex: 0,
      },
      store
    );
    expect(a.link.merchantProductId).not.toBe(b.link.merchantProductId);
  });

  it('does not merge cola vs cola ZERO', () => {
    const store = createMemoryProductIdentityStore();
    const a = resolveReceiptItemIdentity(
      { rawName: 'コカコーラ500ml', merchantKey: 'm1', receiptId: 'r1', itemSourceIndex: 0 },
      store
    );
    const b = resolveReceiptItemIdentity(
      {
        rawName: 'コカコーラZERO500ml',
        merchantKey: 'm1',
        receiptId: 'r2',
        itemSourceIndex: 0,
      },
      store
    );
    expect(a.link.merchantProductId).not.toBe(b.link.merchantProductId);
  });

  it('cross merchant creates distinct MerchantProducts without canonical', () => {
    const store = createMemoryProductIdentityStore();
    const a = resolveReceiptItemIdentity(
      {
        rawName: '東北恵牛乳1L',
        merchantKey: 'ヨークベニマル',
        receiptId: 'r1',
        itemSourceIndex: 0,
      },
      store
    );
    const b = resolveReceiptItemIdentity(
      {
        rawName: '東北恵牛乳1L',
        merchantKey: 'イオン',
        receiptId: 'r2',
        itemSourceIndex: 0,
      },
      store
    );
    expect(a.link.merchantProductId).toBeTruthy();
    expect(b.link.merchantProductId).toBeTruthy();
    expect(a.link.merchantProductId).not.toBe(b.link.merchantProductId);
    expect(a.link.canonicalProductId).toBeNull();
    expect(b.link.canonicalProductId).toBeNull();
  });

  it('generic milk stays family_spec / family_only, not product_exact', () => {
    const store = createMemoryProductIdentityStore();
    const r = resolveReceiptItemIdentity(
      { rawName: '牛乳 1L', merchantKey: 'm1', receiptId: 'r1', itemSourceIndex: 0 },
      store
    );
    expect(r.link.identityLevel).not.toBe('product_exact');
    expect(r.link.identityLevel).not.toBe('sku_exact');
    expect(['family_spec', 'family_only']).toContain(r.link.identityLevel);
    expect(r.link.canonicalProductId).toBeNull();
  });

  it('unknown product can remain unresolved or create merchant product safely', () => {
    const store = createMemoryProductIdentityStore();
    const r = resolveReceiptItemIdentity(
      {
        rawName: '謎商品ABC',
        merchantKey: 'm1',
        receiptId: 'r1',
        itemSourceIndex: 0,
      },
      store
    );
    expect(r.link.skuId).toBeNull();
    expect(r.link.canonicalProductId).toBeNull();
    // Either unresolved (empty key) or merchant_product with no canonical — both OK.
    expect(['unresolved', 'merchant_product', 'family_only']).toContain(
      r.link.identityLevel
    );
  });

  it('stale fingerprint invalidates prior identity link', () => {
    const store = createMemoryProductIdentityStore();
    const first = resolveReceiptItemIdentity(
      {
        rawName: '東北恵牛乳1L',
        merchantKey: 'm1',
        receiptId: 'r1',
        itemSourceIndex: 0,
        quantity: 1,
        lineTotal: 200,
      },
      store
    );
    expect(first.link.merchantProductId).toBeTruthy();
    const cached = store.getLink('r1', 0);
    expect(cached?.stale).toBe(false);

    const second = resolveReceiptItemIdentity(
      {
        rawName: '東北恵牛乳1L 編集後',
        merchantKey: 'm1',
        receiptId: 'r1',
        itemSourceIndex: 0,
        quantity: 2,
        lineTotal: 400,
      },
      store
    );
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.reason).not.toBe('cache_hit');
    const after = store.getLink('r1', 0);
    expect(after?.itemFingerprint).toBe(second.fingerprint);
    expect(after?.stale).toBe(false);
  });

  it('clearDerived allows full rebuild without affecting input observations', () => {
    const store = createMemoryProductIdentityStore();
    resolveReceiptItemIdentity(
      { rawName: '東北恵牛乳1L', merchantKey: 'm1', receiptId: 'r1', itemSourceIndex: 0 },
      store
    );
    expect(store.listMerchantProducts('m1').length).toBe(1);
    store.clearDerived();
    expect(store.listMerchantProducts('m1').length).toBe(0);
    expect(store.getLink('r1', 0)).toBeNull();
    const rebuilt = resolveReceiptItemIdentity(
      { rawName: '東北恵牛乳1L', merchantKey: 'm1', receiptId: 'r1', itemSourceIndex: 0 },
      store
    );
    expect(rebuilt.link.merchantProductId).toBeTruthy();
  });

  it('fingerprint changes when attributes change', () => {
    const a = normalizeProductForIdentity('コーラ500ml');
    const b = normalizeProductForIdentity('コーラ1.5L');
    const fa = buildItemIdentityFingerprint({
      rawName: 'コーラ500ml',
      normalizedName: a.normalizedName,
      comparisonKey: a.comparisonKey,
      attributes: a.attributes,
    });
    const fb = buildItemIdentityFingerprint({
      rawName: 'コーラ1.5L',
      normalizedName: b.normalizedName,
      comparisonKey: b.comparisonKey,
      attributes: b.attributes,
    });
    expect(fa).not.toBe(fb);
  });
});

describe('Product Identity Batch 3 — schema', () => {
  it('includes comparison_key and receipt_item_identity_links', async () => {
    const executed: string[] = [];
    const db = {
      execAsync: async (source: string) => {
        executed.push(source);
      },
    };
    await ensureProductIdentityEntitySchema(db);
    expect(PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL).toContain('comparison_key');
    expect(PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL).toContain(
      'receipt_item_identity_links'
    );
    expect(PRODUCT_IDENTITY_ENTITY_SCHEMA_SQL).toContain('item_fingerprint');
    expect(executed.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Product Identity Batch 3 — shadow audit helper', () => {
  it('runs in-memory without writing receipt truth', () => {
    const observations = observationsFromProductIntelligenceExport({
      receipts: [
        {
          id: 'r1',
          merchant_normalized: 'ヨークベニマル',
        },
        { id: 'r2', merchant_normalized: 'イオン' },
      ],
      receiptItems: [
        {
          receipt_id: 'r1',
          source_index: 0,
          raw_name: '東北恵牛乳1L',
          quantity: 1,
          line_total: 198,
        },
        {
          receipt_id: 'r1',
          source_index: 1,
          raw_name: 'コーラ500ml',
          quantity: 1,
          line_total: 120,
        },
        {
          receipt_id: 'r1',
          source_index: 2,
          raw_name: 'コーラ1.5L',
          quantity: 1,
          line_total: 180,
        },
        {
          receipt_id: 'r2',
          source_index: 0,
          raw_name: '東北恵牛乳1L',
          quantity: 1,
          line_total: 205,
        },
        {
          receipt_id: 'r2',
          source_index: 1,
          raw_name: '謎商品ABC',
          quantity: 1,
          line_total: 99,
        },
      ],
    });
    const report = runShadowIdentityAudit(observations);
    expect(report.dataset.eligibleItemObservations).toBe(5);
    expect(report.thresholds.fuzzyAutoMatch).toBe(FUZZY_AUTO_MATCH_THRESHOLD);
    expect(
      report.entityAssignment.distinctMerchantProducts
    ).toBeGreaterThanOrEqual(2);
    // Levels partition eligible observations
    const levelSum = Object.values(report.byLevel).reduce((a, b) => a + b, 0);
    expect(levelSum).toBe(report.dataset.eligibleItemObservations);
    // Existing match + new entity = assigned merchant containers
    expect(
      report.entityAssignment.merchantProductExistingMatch +
        report.entityAssignment.merchantProductNewEntity
    ).toBe(report.entityAssignment.merchantProductTotalAssigned);
  });
});

describe('Batch 3 freeze — no AI / Analysis wiring in resolver', () => {
  it('resolver does not import generative AI modules', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.join(__dirname, 'productIdentityResolver.ts'),
      'utf8'
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/from ['"].*(gemini|openai|generative)/i);
    expect(code).not.toMatch(/semantic_enrichment|ai_semantic/);
  });
});
