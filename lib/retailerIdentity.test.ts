/**
 * R1-B2 — Derived retailer identity tests.
 *
 * Must NOT alter merchant_raw / merchant_normalized / merchantAnalyticsKey.
 */

import {
  deriveRetailerIdentity,
  extractStoreHint,
  RETAILER_IDENTITY_REGISTRY,
} from './retailerIdentity';
import { merchantAnalyticsKey } from './merchantAnalytics';
import { normalizeMerchantName } from './productNormalizer';
import {
  canonicalizeMerchantChain,
  normalizeMerchant,
} from './receiptOcrNormalize';
import { isV1SupportedMerchantType } from './merchantType';

describe('R1-B2 derived retailer identity', () => {
  describe('A — deterministic known-chain resolution', () => {
    it.each([
      ['コストコ', 'costco', 'コストコ'],
      ['業務スーパー', 'gyomu_super', '業務スーパー'],
      ['ヨークベニマル', 'york_benimaru', 'ヨークベニマル'],
      ['セブン-イレブン', 'seven_eleven', 'セブン-イレブン'],
      ['ファミリーマート', 'familymart', 'ファミリーマート'],
      ['ローソン', 'lawson', 'ローソン'],
      ['ミニストップ', 'ministop', 'ミニストップ'],
      ['イオン', 'aeon', 'イオン'],
    ] as const)('%s → %s', (display, key, expectedDisplay) => {
      const id = deriveRetailerIdentity({
        merchantNormalized: display,
        merchantRaw: display,
      });
      expect(id.retailerKey).toBe(key);
      expect(id.retailerDisplayName).toBe(expectedDisplay);
      expect(id.source).not.toBe('unresolved');
      expect(id.confidence).toBe('exact');
    });
  });

  describe('B — aliases via existing normalization resolve to same retailer', () => {
    it('Costco aliases share costco', () => {
      const variants = [
        'コストコ',
        'Costco',
        'Costco Wholesale',
        'コストコホールセール',
      ];
      const keys = variants.map((v) =>
        deriveRetailerIdentity({ merchantRaw: v, merchantNormalized: null })
          .retailerKey
      );
      expect(new Set(keys)).toEqual(new Set(['costco']));
    });

    it('convenience aliases share retailer keys with canonicalizeMerchantChain', () => {
      expect(
        deriveRetailerIdentity({
          merchantRaw: '7-Eleven',
          merchantNormalized: canonicalizeMerchantChain('7-Eleven'),
        }).retailerKey
      ).toBe('seven_eleven');
      expect(
        deriveRetailerIdentity({
          merchantRaw: 'ファミマ',
          merchantNormalized: normalizeMerchant('ファミマ'),
        }).retailerKey
      ).toBe('familymart');
      expect(
        deriveRetailerIdentity({ merchantRaw: 'LAWSON' }).retailerKey
      ).toBe('lawson');
      expect(
        deriveRetailerIdentity({ merchantRaw: 'ministop' }).retailerKey
      ).toBe('ministop');
      expect(
        deriveRetailerIdentity({ merchantRaw: 'AEON' }).retailerKey
      ).toBe('aeon');
    });
  });

  describe('C — Gyomu Super branch-looking strings', () => {
    it.each([
      '業務スーパー',
      '業務スーパー古川',
      '業務スーパー 古川',
      '業務スーパー古川店',
    ])('retains gyomu_super for %s', (raw) => {
      const id = deriveRetailerIdentity({ merchantRaw: raw });
      expect(id.retailerKey).toBe('gyomu_super');
      expect(id.retailerDisplayName).toBe('業務スーパー');
    });

    it('optional storeHint retains branch residue', () => {
      expect(
        deriveRetailerIdentity({ merchantRaw: '業務スーパー古川' }).storeHint
      ).toBe('古川');
      expect(
        deriveRetailerIdentity({ merchantRaw: '業務スーパー 古川' }).storeHint
      ).toBe('古川');
      expect(
        deriveRetailerIdentity({ merchantRaw: '業務スーパー古川店' }).storeHint
      ).toBe('古川店');
      expect(
        deriveRetailerIdentity({ merchantRaw: '業務スーパー' }).storeHint
      ).toBeNull();
    });
  });

  describe('D — York Benimaru branch-looking strings', () => {
    it.each(['ヨークベニマル', 'ヨークベニマル古川店', 'ヨークベニマル 古川'])(
      'retains york_benimaru for %s',
      (raw) => {
        const id = deriveRetailerIdentity({ merchantRaw: raw });
        expect(id.retailerKey).toBe('york_benimaru');
        expect(id.retailerDisplayName).toBe('ヨークベニマル');
      }
    );

    it('optional storeHint retains branch residue', () => {
      expect(
        deriveRetailerIdentity({ merchantRaw: 'ヨークベニマル古川店' }).storeHint
      ).toBe('古川店');
    });
  });

  describe('E — unknown merchant remains unresolved', () => {
    it('does not invent retailerKey from arbitrary names', () => {
      const id = deriveRetailerIdentity({
        merchantRaw: '山田商店',
        merchantNormalized: '山田商店',
      });
      expect(id).toEqual({
        retailerKey: null,
        retailerDisplayName: null,
        storeHint: null,
        source: 'unresolved',
        confidence: 'unknown',
      });
    });
  });

  describe('F — deterministic stability', () => {
    it('same input always returns same retailerKey', () => {
      const input = {
        merchantRaw: '業務スーパー古川店',
        merchantNormalized: '業務スーパー古川店',
      };
      const a = deriveRetailerIdentity(input);
      const b = deriveRetailerIdentity(input);
      expect(a).toEqual(b);
      expect(a.retailerKey).toBe('gyomu_super');
    });
  });

  describe('G/H — does not mutate merchant_raw / merchant_normalized', () => {
    it('leaves input strings unchanged', () => {
      const merchantRaw = '業務スーパー古川';
      const merchantNormalized = '業務スーパー古川';
      const rawBefore = merchantRaw;
      const normBefore = merchantNormalized;
      deriveRetailerIdentity({ merchantRaw, merchantNormalized });
      expect(merchantRaw).toBe(rawBefore);
      expect(merchantNormalized).toBe(normBefore);
      expect(merchantRaw).toBe('業務スーパー古川');
      expect(merchantNormalized).toBe('業務スーパー古川');
    });
  });

  describe('I — storeHint is never a store ID', () => {
    it('is plain parse residue, not uuid / numeric id / storeKey', () => {
      const hint = deriveRetailerIdentity({
        merchantRaw: 'ヨークベニマル古川店',
      }).storeHint;
      expect(hint).toBe('古川店');
      expect(hint).not.toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      );
      expect(hint).not.toMatch(/^\d+$/);
      expect(extractStoreHint('業務スーパー古川', '業務スーパー')).toBe('古川');
    });
  });

  describe('false-positive protections', () => {
    it('generic スーパー does not become gyomu_super', () => {
      expect(
        deriveRetailerIdentity({ merchantRaw: '近所のスーパー' }).retailerKey
      ).toBeNull();
      expect(
        deriveRetailerIdentity({ merchantRaw: 'スーパーマーケットABC' })
          .retailerKey
      ).toBeNull();
      expect(
        deriveRetailerIdentity({ merchantRaw: 'スーパー' }).retailerKey
      ).toBeNull();
    });

    it('arbitrary York-like text does not become york_benimaru', () => {
      expect(
        deriveRetailerIdentity({ merchantRaw: 'York Hotel' }).retailerKey
      ).toBeNull();
      expect(
        deriveRetailerIdentity({ merchantRaw: 'New York Deli' }).retailerKey
      ).toBeNull();
      expect(
        deriveRetailerIdentity({ merchantRaw: 'ベニマル食堂' }).retailerKey
      ).toBeNull();
    });

    it('noisy Costco-like partial only resolves when explicit rules justify', () => {
      // Existing canonicalize uses includes('costco'|'コストコ') — partial latin
      // without those tokens stays unresolved.
      expect(
        deriveRetailerIdentity({ merchantRaw: 'cstco' }).retailerKey
      ).toBeNull();
      expect(
        deriveRetailerIdentity({ merchantRaw: 'コスト' }).retailerKey
      ).toBeNull();
      // Explicit token still resolves (reuse of existing canonical evidence).
      expect(
        deriveRetailerIdentity({ merchantRaw: 'costco' }).retailerKey
      ).toBe('costco');
    });
  });

  describe('analytics freeze — merchantAnalyticsKey unchanged', () => {
    const fixtures = [
      {
        merchant_raw: 'セブンイレブン 渋谷店',
        merchant_normalized: 'セブン-イレブン',
      },
      {
        merchant_raw: '業務スーパー古川店',
        merchant_normalized: null as string | null,
      },
      {
        merchant_raw: 'ヨークベニマル古川店',
        merchant_normalized: 'ヨークベニマル古川店',
      },
      {
        merchant_raw: 'Costco Wholesale',
        merchant_normalized: 'コストコ',
      },
      {
        merchant_raw: '山田商店',
        merchant_normalized: '山田商店',
      },
      {
        merchant_raw: 'ファミマ',
        merchant_normalized: 'ファミリーマート',
      },
    ];

    it('deriveRetailerIdentity does not change merchantAnalyticsKey outputs', () => {
      for (const f of fixtures) {
        const before = merchantAnalyticsKey(f);
        deriveRetailerIdentity({
          merchantRaw: f.merchant_raw,
          merchantNormalized: f.merchant_normalized,
        });
        const after = merchantAnalyticsKey(f);
        expect(after).toBe(before);
        expect(after).toBe(
          normalizeMerchantName(f.merchant_normalized || f.merchant_raw || '')
        );
      }
    });

    it('Gyomu/York branch strings keep distinct analytics keys (no collapse)', () => {
      // Production analytics still keys on full normalized/raw observation.
      expect(
        merchantAnalyticsKey({
          merchant_raw: '業務スーパー古川',
          merchant_normalized: null,
        })
      ).toBe(normalizeMerchantName('業務スーパー古川'));
      expect(
        merchantAnalyticsKey({
          merchant_raw: '業務スーパー',
          merchant_normalized: null,
        })
      ).toBe(normalizeMerchantName('業務スーパー'));
      expect(
        merchantAnalyticsKey({
          merchant_raw: '業務スーパー古川',
          merchant_normalized: null,
        })
      ).not.toBe(
        merchantAnalyticsKey({
          merchant_raw: '業務スーパー',
          merchant_normalized: null,
        })
      );
    });
  });

  describe('V1 support universe unchanged', () => {
    it('does not alter isV1SupportedMerchantType', () => {
      expect(isV1SupportedMerchantType('supermarket')).toBe(true);
      expect(isV1SupportedMerchantType('convenience')).toBe(true);
      expect(isV1SupportedMerchantType('other')).toBe(false);
      expect(isV1SupportedMerchantType('unknown')).toBe(false);
    });
  });

  describe('registry SSOT', () => {
    it('exposes exactly the initial evidenced retailers', () => {
      const keys = RETAILER_IDENTITY_REGISTRY.map((r) => r.retailerKey).sort();
      expect(keys).toEqual(
        [
          'aeon',
          'costco',
          'familymart',
          'gyomu_super',
          'lawson',
          'ministop',
          'seven_eleven',
          'york_benimaru',
        ].sort()
      );
    });
  });

  describe('precedence — inspect both normalized and raw for storeHint', () => {
    it('uses raw branch suffix when normalized collapsed chain-only', () => {
      // Simulate future/partial collapse: normalized is chain-only, raw has branch.
      const id = deriveRetailerIdentity({
        merchantNormalized: '業務スーパー',
        merchantRaw: '業務スーパー古川店',
      });
      expect(id.retailerKey).toBe('gyomu_super');
      expect(id.storeHint).toBe('古川店');
    });
  });
});
