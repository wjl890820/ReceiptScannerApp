/**
 * Receipt073 — generic MP bucket ≠ merchant-product price comparability.
 * Focused regressions for identity rematch laundering + PPH identity trust.
 */

/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('./db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import {
  classifyGenericWeakIdentity,
  isMerchantProductIdentityPriceComparable,
} from './productIdentityGenericLabel';
import {
  evaluateMerchantProductHistoryEligibility,
  hasAmbiguousGenericSameReceiptMpCollision,
} from './productIdentityPriceObservationQuality';
import {
  tryBuildIdentityPriceHistoryForRows,
} from './productIdentityConsumer';
import { resolveReceiptItemIdentity } from './productIdentityResolver';
import {
  createMemoryProductIdentityStore,
  deterministicMerchantProductId,
} from './productIdentityStore';
import { PRODUCT_IDENTITY_RESOLVER_VERSION } from './productIdentityContract';
import { normalizeProductForIdentity } from './normalizeProductForIdentity';
import { resolveProductIdentity } from './productIdentity';
import {
  buildMerchantProductPriceHistoryFromRows,
  type ProductPriceHistoryRow,
} from './productPriceHistory';
import { makeTrustedG3TestRow } from './productPriceHistory.testFixtures';

describe('Receipt073 generic MP / PPH identity trust', () => {
  const merchantKey = 'イオン';
  const genericName = 'パン';
  const expectedMp = deterministicMerchantProductId(merchantKey, 'パン');

  it('Test 1 — generic first observation stays weak; MP may exist but not PPH-comparable', () => {
    expect(expectedMp).toBe('mp_43cf04589189b51a');
    const store = createMemoryProductIdentityStore();
    const first = resolveReceiptItemIdentity(
      {
        rawName: genericName,
        merchantKey,
        receiptId: 'r1',
        itemSourceIndex: 0,
        quantity: 1,
        lineTotal: 280,
      },
      store
    );
    expect(first.link.merchantProductId).toBe(expectedMp);
    expect(first.link.identityLevel).toBe('family_only');
    expect(first.link.identitySource).toBe('family_only');
    expect(first.link.identityConfidence).toBe(0.35);
    expect(
      isMerchantProductIdentityPriceComparable({
        rawName: genericName,
        identityLevel: first.link.identityLevel,
        identitySource: first.link.identitySource,
      })
    ).toBe(false);

    const eligibility = evaluateMerchantProductHistoryEligibility({
      merchantProductId: expectedMp,
      observations: [
        {
          occurredAt: Date.parse('2026-06-01'),
          quality: 'trusted',
          rawName: genericName,
          identityLevel: 'family_only',
          identitySource: 'family_only',
          receiptId: 'r1',
          purchaseUnitPrice: 280,
        },
      ],
    });
    expect(eligibility.hasMerchantProductIdentity).toBe(true);
    expect(eligibility.priceHistoryEligible).toBe(false);
  });

  it('Test 2 — generic exact rematch must not launder to merchant_product/normalized_exact', () => {
    const store = createMemoryProductIdentityStore();
    const first = resolveReceiptItemIdentity(
      {
        rawName: genericName,
        merchantKey,
        receiptId: 'r1',
        itemSourceIndex: 0,
        lineTotal: 280,
      },
      store
    );
    const second = resolveReceiptItemIdentity(
      {
        rawName: genericName,
        merchantKey,
        receiptId: 'r2',
        itemSourceIndex: 0,
        lineTotal: 160,
      },
      store
    );
    expect(second.link.merchantProductId).toBe(first.link.merchantProductId);
    expect(second.link.identityLevel).toBe('family_only');
    expect(second.link.identitySource).toBe('family_only');
    expect(second.link.identityConfidence).toBe(0.35);
    expect(second.link.identityLevel).not.toBe('merchant_product');
    expect(second.link.identitySource).not.toBe('normalized_exact');
  });

  it('Test 3 — historically washed identity still fails PPH at read time', () => {
    expect(
      isMerchantProductIdentityPriceComparable({
        rawName: genericName,
        identityLevel: 'merchant_product',
        identitySource: 'normalized_exact',
      })
    ).toBe(false);

    const eligibility = evaluateMerchantProductHistoryEligibility({
      merchantProductId: expectedMp,
      observations: [
        {
          occurredAt: Date.parse('2026-06-01'),
          quality: 'trusted',
          rawName: genericName,
          identityLevel: 'merchant_product',
          identitySource: 'normalized_exact',
          receiptId: 'rA',
          purchaseUnitPrice: 280,
        },
        {
          occurredAt: Date.parse('2026-06-18'),
          quality: 'trusted',
          rawName: genericName,
          identityLevel: 'merchant_product',
          identitySource: 'normalized_exact',
          receiptId: 'rB',
          purchaseUnitPrice: 160,
        },
      ],
    });
    expect(eligibility.priceHistoryEligible).toBe(false);
  });

  it('Test 4 — cross-receipt generic price change is not ready merchant_product history', () => {
    const rows: ProductPriceHistoryRow[] = [
      makeTrustedG3TestRow('a', {
        receiptId: 'DyirFAlMK7sky68_pD-Uq',
        sourceIndex: 2,
        occurredAt: Date.parse('2026-06-18'),
        merchantRaw: 'イオン古川店',
        merchantNormalized: merchantKey,
        displayName: genericName,
        lineTotal: 280,
        grossLineAmount: 280,
        effectiveLineAmount: 252,
      }),
      makeTrustedG3TestRow('b', {
        receiptId: 'receipt-b',
        sourceIndex: 0,
        occurredAt: Date.parse('2026-05-01'),
        merchantRaw: 'イオン古川店',
        merchantNormalized: merchantKey,
        displayName: genericName,
        lineTotal: 160,
        grossLineAmount: 160,
        effectiveLineAmount: 160,
      }),
    ];
    const view = tryBuildIdentityPriceHistoryForRows(rows, expectedMp);
    expect(view).toBeNull();

    const history = buildMerchantProductPriceHistoryFromRows(expectedMp, rows);
    expect(history.status).not.toBe('ready');
    expect(history.points.length).toBe(0);
  });

  it('Test 5 — same-receipt generic collision yields no trusted same-product history', () => {
    const receiptId = 'FlyKjHb4ZAQIJcNYd_BYR';
    const rows: ProductPriceHistoryRow[] = [
      makeTrustedG3TestRow('1', {
        receiptId,
        sourceIndex: 3,
        occurredAt: Date.parse('2026-06-10'),
        merchantRaw: 'イオン古川店',
        merchantNormalized: merchantKey,
        displayName: genericName,
        lineTotal: 190,
        grossLineAmount: 190,
      }),
      makeTrustedG3TestRow('2', {
        receiptId,
        sourceIndex: 7,
        occurredAt: Date.parse('2026-06-10'),
        merchantRaw: 'イオン古川店',
        merchantNormalized: merchantKey,
        displayName: genericName,
        lineTotal: 160,
        grossLineAmount: 160,
      }),
    ];
    expect(
      hasAmbiguousGenericSameReceiptMpCollision([
        {
          occurredAt: Date.parse('2026-06-10'),
          quality: 'trusted',
          rawName: genericName,
          identityLevel: 'family_only',
          identitySource: 'family_only',
          receiptId,
          itemSourceIndex: 3,
          purchaseUnitPrice: 190,
        },
        {
          occurredAt: Date.parse('2026-06-10'),
          quality: 'trusted',
          rawName: genericName,
          identityLevel: 'family_only',
          identitySource: 'family_only',
          receiptId,
          itemSourceIndex: 7,
          purchaseUnitPrice: 160,
        },
      ])
    ).toBe(true);

    const view = tryBuildIdentityPriceHistoryForRows(rows, expectedMp);
    expect(view).toBeNull();
    const history = buildMerchantProductPriceHistoryFromRows(expectedMp, rows);
    expect(history.status).not.toBe('ready');
  });

  it('Test 6 — strong merchant product positive control still becomes ready', () => {
    const rows: ProductPriceHistoryRow[] = [
      makeTrustedG3TestRow('s1', {
        receiptId: 'sr1',
        occurredAt: Date.parse('2026-01-01'),
        merchantRaw: 'ヨークベニマル',
        merchantNormalized: 'ヨークベニマル',
        displayName: '横浜家系',
        lineTotal: 397,
        grossLineAmount: 397,
      }),
      makeTrustedG3TestRow('s2', {
        receiptId: 'sr2',
        occurredAt: Date.parse('2026-02-01'),
        merchantRaw: 'ヨークベニマル',
        merchantNormalized: 'ヨークベニマル',
        displayName: '横浜家系',
        lineTotal: 410,
        grossLineAmount: 410,
      }),
    ];
    const view = tryBuildIdentityPriceHistoryForRows(rows);
    expect(view).not.toBeNull();
    expect(view!.priceHistoryEligible).toBe(true);
    const history = buildMerchantProductPriceHistoryFromRows(
      view!.merchantProductId,
      rows
    );
    expect(history.status).toBe('ready');
    expect(history.points.length).toBeGreaterThanOrEqual(2);
  });

  it('Test 7 — legitimate same-SKU duplicate rows are not blindly rejected', () => {
    const receiptId = 'dup-sku-receipt';
    const rows: ProductPriceHistoryRow[] = [
      makeTrustedG3TestRow('d1', {
        receiptId,
        sourceIndex: 0,
        occurredAt: Date.parse('2026-03-01'),
        merchantRaw: 'ヨークベニマル',
        merchantNormalized: 'ヨークベニマル',
        displayName: '横浜家系',
        lineTotal: 397,
        grossLineAmount: 397,
        purchaseQuantity: 1,
      }),
      makeTrustedG3TestRow('d2', {
        receiptId,
        sourceIndex: 1,
        occurredAt: Date.parse('2026-03-01'),
        merchantRaw: 'ヨークベニマル',
        merchantNormalized: 'ヨークベニマル',
        displayName: '横浜家系',
        lineTotal: 397,
        grossLineAmount: 397,
        purchaseQuantity: 1,
      }),
      makeTrustedG3TestRow('d3', {
        receiptId: 'other-day',
        sourceIndex: 0,
        occurredAt: Date.parse('2026-04-01'),
        merchantRaw: 'ヨークベニマル',
        merchantNormalized: 'ヨークベニマル',
        displayName: '横浜家系',
        lineTotal: 410,
        grossLineAmount: 410,
      }),
    ];
    expect(
      hasAmbiguousGenericSameReceiptMpCollision(
        rows.map((r) => ({
          occurredAt: r.occurredAt,
          quality: 'trusted' as const,
          rawName: r.displayName,
          identityLevel: 'merchant_product',
          identitySource: 'normalized_exact',
          receiptId: r.receiptId,
          itemSourceIndex: r.sourceIndex,
          purchaseUnitPrice: r.lineTotal,
        }))
      )
    ).toBe(false);

    const view = tryBuildIdentityPriceHistoryForRows(rows);
    expect(view?.priceHistoryEligible).toBe(true);
    const history = buildMerchantProductPriceHistoryFromRows(
      view!.merchantProductId,
      rows
    );
    expect(history.status).toBe('ready');
  });

  it('Test 8A — perfect monetary + weak identity → PPH rejected', () => {
    const rows: ProductPriceHistoryRow[] = [
      makeTrustedG3TestRow('m1', {
        receiptId: 'm1',
        occurredAt: Date.parse('2026-01-01'),
        merchantNormalized: merchantKey,
        displayName: genericName,
        lineTotal: 280,
        grossLineAmount: 280,
        effectiveLineAmount: 252,
      }),
      makeTrustedG3TestRow('m2', {
        receiptId: 'm2',
        occurredAt: Date.parse('2026-02-01'),
        merchantNormalized: merchantKey,
        displayName: genericName,
        lineTotal: 160,
        grossLineAmount: 160,
      }),
    ];
    expect(tryBuildIdentityPriceHistoryForRows(rows, expectedMp)).toBeNull();
  });

  it('Test 8B — strong identity + unsafe monetary still rejected by monetary gate', () => {
    const rows: ProductPriceHistoryRow[] = [
      makeTrustedG3TestRow('bad1', {
        receiptId: 'bad1',
        occurredAt: Date.parse('2026-01-01'),
        merchantNormalized: 'ヨークベニマル',
        displayName: '横浜家系',
        lineTotal: 397,
        grossLineAmount: null,
        priceObservationVersion: null,
        itemAmountEvidenceState: null,
      }),
      makeTrustedG3TestRow('bad2', {
        receiptId: 'bad2',
        occurredAt: Date.parse('2026-02-01'),
        merchantNormalized: 'ヨークベニマル',
        displayName: '横浜家系',
        lineTotal: 410,
        grossLineAmount: null,
        priceObservationVersion: null,
        itemAmountEvidenceState: null,
      }),
    ];
    const view = tryBuildIdentityPriceHistoryForRows(rows);
    // Identity may still build a view from line totals, but G3 monetary path must not be ready.
    if (view) {
      const history = buildMerchantProductPriceHistoryFromRows(
        view.merchantProductId,
        rows
      );
      expect(history.status).not.toBe('ready');
    } else {
      expect(view).toBeNull();
    }
  });

  it('specific rematch still resolves as merchant_product / normalized_exact', () => {
    const store = createMemoryProductIdentityStore();
    const a = resolveReceiptItemIdentity(
      {
        rawName: '横浜家系',
        merchantKey: 'ヨークベニマル',
        receiptId: 'a',
        itemSourceIndex: 0,
        lineTotal: 397,
      },
      store
    );
    const b = resolveReceiptItemIdentity(
      {
        rawName: '横浜家系',
        merchantKey: 'ヨークベニマル',
        receiptId: 'b',
        itemSourceIndex: 0,
        lineTotal: 410,
      },
      store
    );
    expect(b.link.merchantProductId).toBe(a.link.merchantProductId);
    expect(b.link.identityLevel).toBe('merchant_product');
    expect(b.link.identitySource).toBe('normalized_exact');
  });

  it('family_spec rematch stays family_spec and is NOT merchant-product PPH comparable', () => {
    const store = createMemoryProductIdentityStore();
    const name = '牛乳 1L';
    const norm = normalizeProductForIdentity(name);
    const legacy = resolveProductIdentity({ rawName: name });
    const weak = classifyGenericWeakIdentity(
      norm.normalizedName,
      legacy.productFamilyKey,
      norm.attributes
    );
    expect(weak?.level).toBe('family_spec');

    resolveReceiptItemIdentity(
      { rawName: name, merchantKey: '店', receiptId: 'r1', itemSourceIndex: 0, lineTotal: 198 },
      store
    );
    const second = resolveReceiptItemIdentity(
      { rawName: name, merchantKey: '店', receiptId: 'r2', itemSourceIndex: 0, lineTotal: 258 },
      store
    );
    expect(second.link.identityLevel).toBe('family_spec');
    expect(second.link.identitySource).toBe('family_spec');
    expect(
      isMerchantProductIdentityPriceComparable({
        nameForIdentityTrust: name,
        identityLevel: second.link.identityLevel,
        identitySource: second.link.identitySource,
      })
    ).toBe(false);

    const rows: ProductPriceHistoryRow[] = [
      makeTrustedG3TestRow('m1', {
        receiptId: 'r1',
        merchantNormalized: '店',
        displayName: name,
        lineTotal: 198,
        grossLineAmount: 198,
        occurredAt: Date.parse('2026-01-01'),
      }),
      makeTrustedG3TestRow('m2', {
        receiptId: 'r2',
        merchantNormalized: '店',
        displayName: name,
        lineTotal: 258,
        grossLineAmount: 258,
        occurredAt: Date.parse('2026-02-01'),
      }),
    ];
    expect(tryBuildIdentityPriceHistoryForRows(rows)).toBeNull();
  });
});

describe('Receipt073 Round 2 — A1 decoration / A2 family_spec / A3 cache', () => {
  const merchantKey = 'イオン';

  it.each(['パン', 'パン　', 'パン*', 'パン※', 'パン(税)'])(
    'A1 — decorated generic %j shares weak family_only semantics',
    (label) => {
      const store = createMemoryProductIdentityStore();
      const result = resolveReceiptItemIdentity(
        {
          rawName: label,
          merchantKey,
          receiptId: 'd1',
          itemSourceIndex: 0,
          lineTotal: 280,
        },
        store
      );
      expect(result.link.identityLevel).toBe('family_only');
      expect(result.link.identitySource).toBe('family_only');
      expect(result.link.identityConfidence).toBe(0.35);
      expect(
        isMerchantProductIdentityPriceComparable({
          nameForIdentityTrust: label,
          identityLevel: result.link.identityLevel,
          identitySource: result.link.identitySource,
        })
      ).toBe(false);
    }
  );

  it('A1 — decorated パン* cross-receipt is not ready MP history', () => {
    const rows: ProductPriceHistoryRow[] = [
      makeTrustedG3TestRow('a', {
        receiptId: 'ra',
        occurredAt: Date.parse('2026-06-01'),
        merchantNormalized: merchantKey,
        displayName: 'パン*',
        lineTotal: 280,
        grossLineAmount: 280,
        effectiveLineAmount: 252,
        discountAllocated: -28,
      }),
      makeTrustedG3TestRow('b', {
        receiptId: 'rb',
        occurredAt: Date.parse('2026-06-18'),
        merchantNormalized: merchantKey,
        displayName: 'パン*',
        lineTotal: 160,
        grossLineAmount: 160,
      }),
    ];
    expect(rows[0]!.discountAllocated).toBe(-28);
    expect(rows[0]!.effectiveLineAmount).toBe(252);
    expect(rows[0]!.grossLineAmount).toBe(280);
    expect(tryBuildIdentityPriceHistoryForRows(rows)).toBeNull();
    const history = buildMerchantProductPriceHistoryFromRows(
      deterministicMerchantProductId(merchantKey, normalizeProductForIdentity('パン*').comparisonKey),
      rows
    );
    expect(history.status).not.toBe('ready');
  });

  it('A1 — specific product with trailing receipt marker stays non-generic', () => {
    const store = createMemoryProductIdentityStore();
    const result = resolveReceiptItemIdentity(
      {
        rawName: '横浜家系*',
        merchantKey: 'ヨークベニマル',
        receiptId: 's1',
        itemSourceIndex: 0,
        lineTotal: 397,
      },
      store
    );
    expect(result.link.identityLevel).toBe('merchant_product');
    expect(result.link.identityLevel).not.toBe('family_only');
    expect(
      isMerchantProductIdentityPriceComparable({
        nameForIdentityTrust: '横浜家系*',
        identityLevel: result.link.identityLevel,
        identitySource: result.link.identitySource,
      })
    ).toBe(true);
  });

  it('A2 — historical washed family_spec 牛乳 1L fails MP PPH', () => {
    expect(
      isMerchantProductIdentityPriceComparable({
        nameForIdentityTrust: '牛乳 1L',
        identityLevel: 'merchant_product',
        identitySource: 'normalized_exact',
      })
    ).toBe(false);
    const eligibility = evaluateMerchantProductHistoryEligibility({
      merchantProductId: 'mp_fake_milk',
      observations: [
        {
          occurredAt: 1,
          quality: 'trusted',
          nameForIdentityTrust: '牛乳 1L',
          identityLevel: 'merchant_product',
          identitySource: 'normalized_exact',
          receiptId: 'a',
          purchaseUnitPrice: 198,
        },
        {
          occurredAt: 2,
          quality: 'trusted',
          nameForIdentityTrust: '牛乳 1L',
          identityLevel: 'merchant_product',
          identitySource: 'normalized_exact',
          receiptId: 'b',
          purchaseUnitPrice: 258,
        },
      ],
    });
    expect(eligibility.priceHistoryEligible).toBe(false);
  });

  it('A3 — stale washed cache for パン is reclassified weak', () => {
    const store = createMemoryProductIdentityStore();
    const first = resolveReceiptItemIdentity(
      {
        rawName: 'パン',
        merchantKey,
        receiptId: 'cache-r',
        itemSourceIndex: 0,
        lineTotal: 280,
      },
      store
    );
    // Simulate pre-fix laundry persisted on the link record.
    store.saveLink({
      receiptId: 'cache-r',
      itemSourceIndex: 0,
      itemFingerprint: first.fingerprint,
      merchantKey,
      merchantProductId: first.link.merchantProductId,
      canonicalProductId: null,
      skuId: null,
      identityLevel: 'merchant_product',
      identityConfidence: 0.97,
      identitySource: 'normalized_exact',
      resolverVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
    });

    const hit = resolveReceiptItemIdentity(
      {
        rawName: 'パン',
        merchantKey,
        receiptId: 'cache-r',
        itemSourceIndex: 0,
        lineTotal: 280,
      },
      store
    );
    expect(hit.reason).toBe('cache_hit_reclassified_generic');
    expect(hit.link.identityLevel).toBe('family_only');
    expect(hit.link.identitySource).toBe('family_only');
    expect(hit.link.identityConfidence).toBe(0.35);
  });

  it('A3 — stale washed cache for decorated パン* is reclassified weak', () => {
    const store = createMemoryProductIdentityStore();
    const first = resolveReceiptItemIdentity(
      {
        rawName: 'パン*',
        merchantKey,
        receiptId: 'cache-star',
        itemSourceIndex: 1,
        lineTotal: 160,
      },
      store
    );
    store.saveLink({
      receiptId: 'cache-star',
      itemSourceIndex: 1,
      itemFingerprint: first.fingerprint,
      merchantKey,
      merchantProductId: first.link.merchantProductId,
      canonicalProductId: null,
      skuId: null,
      identityLevel: 'merchant_product',
      identityConfidence: 0.97,
      identitySource: 'normalized_exact',
      resolverVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
    });
    const hit = resolveReceiptItemIdentity(
      {
        rawName: 'パン*',
        merchantKey,
        receiptId: 'cache-star',
        itemSourceIndex: 1,
        lineTotal: 160,
      },
      store
    );
    expect(hit.link.identityLevel).toBe('family_only');
    expect(hit.reason).toBe('cache_hit_reclassified_generic');
  });

  it('A3 — strong specific cache reuse still works', () => {
    const store = createMemoryProductIdentityStore();
    const first = resolveReceiptItemIdentity(
      {
        rawName: '横浜家系',
        merchantKey: 'ヨークベニマル',
        receiptId: 'strong-cache',
        itemSourceIndex: 0,
        lineTotal: 397,
      },
      store
    );
    expect(first.link.identityLevel).toBe('merchant_product');
    const hit = resolveReceiptItemIdentity(
      {
        rawName: '横浜家系',
        merchantKey: 'ヨークベニマル',
        receiptId: 'strong-cache',
        itemSourceIndex: 0,
        lineTotal: 397,
      },
      store
    );
    expect(hit.reason).toBe('cache_hit');
    expect(hit.link.identityLevel).toBe('merchant_product');
    expect(hit.link.identitySource).toBe('cache');
  });

  it('A3 — Repeat does not receive stale strong generic cache identity', () => {
    const { filterRepeatSafeMerchantObservations } =
      require('./repeatProductProfile') as typeof import('./repeatProductProfile');
    const store = createMemoryProductIdentityStore();
    const first = resolveReceiptItemIdentity(
      {
        rawName: 'パン',
        merchantKey,
        receiptId: 'rep1',
        itemSourceIndex: 0,
        lineTotal: 280,
      },
      store
    );
    store.saveLink({
      receiptId: 'rep1',
      itemSourceIndex: 0,
      itemFingerprint: first.fingerprint,
      merchantKey,
      merchantProductId: first.link.merchantProductId,
      canonicalProductId: null,
      skuId: null,
      identityLevel: 'merchant_product',
      identityConfidence: 0.97,
      identitySource: 'normalized_exact',
      resolverVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
    });
    const hit = resolveReceiptItemIdentity(
      {
        rawName: 'パン',
        merchantKey,
        receiptId: 'rep1',
        itemSourceIndex: 0,
        lineTotal: 280,
      },
      store
    );
    const safe = filterRepeatSafeMerchantObservations([
      { identityLevel: hit.link.identityLevel },
    ]);
    expect(safe).toHaveLength(0);
  });

  it('historical washed decorated generic fails eligibility', () => {
    expect(
      evaluateMerchantProductHistoryEligibility({
        merchantProductId: 'mp_x',
        observations: [
          {
            occurredAt: 1,
            quality: 'trusted',
            nameForIdentityTrust: 'パン※',
            identityLevel: 'merchant_product',
            identitySource: 'normalized_exact',
            receiptId: 'a',
            purchaseUnitPrice: 280,
          },
          {
            occurredAt: 2,
            quality: 'trusted',
            nameForIdentityTrust: 'パン(税)',
            identityLevel: 'merchant_product',
            identitySource: 'normalized_exact',
            receiptId: 'b',
            purchaseUnitPrice: 160,
          },
        ],
      }).priceHistoryEligible
    ).toBe(false);
  });
});
