/**
 * R1-B3a — RetailerProfile metadata tests.
 *
 * Must NOT alter merchant_type, V1 eligibility, or merchantAnalyticsKey.
 */

import {
  getRetailerProfile,
  RETAILER_PROFILE_REGISTRY,
  type RetailerKey,
  type RetailerProfile,
} from './retailerProfile';
import { deriveRetailerIdentity } from './retailerIdentity';
import { merchantAnalyticsKey } from './merchantAnalytics';
import { normalizeMerchantName } from './productNormalizer';
import {
  isV1SupportedMerchantType,
  isV1SupportedReceipt,
  type MerchantType,
} from './merchantType';

const EXPECTED_PROFILES: Record<
  RetailerKey,
  Omit<RetailerProfile, 'retailerKey'>
> = {
  costco: {
    displayName: 'コストコ',
    retailerFormat: 'warehouse_club',
    membershipRequired: true,
    bulkPurchaseFormat: true,
  },
  gyomu_super: {
    displayName: '業務スーパー',
    retailerFormat: 'supermarket',
    membershipRequired: false,
    bulkPurchaseFormat: true,
  },
  york_benimaru: {
    displayName: 'ヨークベニマル',
    retailerFormat: 'supermarket',
    membershipRequired: false,
    bulkPurchaseFormat: false,
  },
  seven_eleven: {
    displayName: 'セブン-イレブン',
    retailerFormat: 'convenience',
    membershipRequired: false,
    bulkPurchaseFormat: false,
  },
  familymart: {
    displayName: 'ファミリーマート',
    retailerFormat: 'convenience',
    membershipRequired: false,
    bulkPurchaseFormat: false,
  },
  lawson: {
    displayName: 'ローソン',
    retailerFormat: 'convenience',
    membershipRequired: false,
    bulkPurchaseFormat: false,
  },
  ministop: {
    displayName: 'ミニストップ',
    retailerFormat: 'convenience',
    membershipRequired: false,
    bulkPurchaseFormat: false,
  },
  aeon: {
    displayName: 'イオン',
    retailerFormat: 'supermarket',
    membershipRequired: false,
    bulkPurchaseFormat: false,
  },
};

describe('R1-B3a retailer profile metadata', () => {
  describe('A — all 8 retailer keys have expected profiles', () => {
    it.each(Object.keys(EXPECTED_PROFILES) as RetailerKey[])(
      '%s has registry profile',
      (key) => {
        const profile = getRetailerProfile(key);
        expect(profile).not.toBeNull();
        expect(profile).toEqual({ retailerKey: key, ...EXPECTED_PROFILES[key] });
      }
    );

    it('registry covers exactly the eight R1-B2 keys', () => {
      const keys = RETAILER_PROFILE_REGISTRY.map((p) => p.retailerKey).sort();
      expect(keys).toEqual(
        (Object.keys(EXPECTED_PROFILES) as string[]).sort()
      );
    });
  });

  describe('B — Costco', () => {
    it('warehouse_club / membership / bulk', () => {
      expect(getRetailerProfile('costco')).toEqual({
        retailerKey: 'costco',
        displayName: 'コストコ',
        retailerFormat: 'warehouse_club',
        membershipRequired: true,
        bulkPurchaseFormat: true,
      });
    });
  });

  describe('C — Gyomu', () => {
    it('supermarket / no membership / bulk format', () => {
      expect(getRetailerProfile('gyomu_super')).toMatchObject({
        retailerFormat: 'supermarket',
        membershipRequired: false,
        bulkPurchaseFormat: true,
      });
    });
  });

  describe('D — York Benimaru', () => {
    it('supermarket / false / false', () => {
      expect(getRetailerProfile('york_benimaru')).toMatchObject({
        retailerFormat: 'supermarket',
        membershipRequired: false,
        bulkPurchaseFormat: false,
      });
    });
  });

  describe('E — convenience chains', () => {
    it.each([
      'seven_eleven',
      'familymart',
      'lawson',
      'ministop',
    ] as const)('%s is convenience / false / false', (key) => {
      expect(getRetailerProfile(key)).toMatchObject({
        retailerFormat: 'convenience',
        membershipRequired: false,
        bulkPurchaseFormat: false,
      });
    });
  });

  describe('F — AEON', () => {
    it('supermarket / false / false', () => {
      expect(getRetailerProfile('aeon')).toMatchObject({
        retailerFormat: 'supermarket',
        membershipRequired: false,
        bulkPurchaseFormat: false,
      });
    });
  });

  describe('G — unknown / unresolved', () => {
    it('does not invent a profile', () => {
      expect(getRetailerProfile(null)).toBeNull();
      expect(getRetailerProfile(undefined)).toBeNull();
      expect(getRetailerProfile('')).toBeNull();
      expect(getRetailerProfile('unknown_chain')).toBeNull();
      expect(getRetailerProfile('山田商店')).toBeNull();
    });
  });

  describe('H — deterministic lookup', () => {
    it('same key always returns equal profile', () => {
      const a = getRetailerProfile('gyomu_super');
      const b = getRetailerProfile('gyomu_super');
      expect(a).toEqual(b);
    });
  });

  describe('I — no duplicate retailerKey in registry', () => {
    it('keys are unique', () => {
      const keys = RETAILER_PROFILE_REGISTRY.map((p) => p.retailerKey);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('J — compose with deriveRetailerIdentity', () => {
    it('業務スーパー古川 → gyomu_super → Gyomu profile without mutating strings', () => {
      const merchantRaw = '業務スーパー古川';
      const merchantNormalized = '業務スーパー古川';
      const identity = deriveRetailerIdentity({
        merchantRaw,
        merchantNormalized,
      });
      expect(identity.retailerKey).toBe('gyomu_super');
      const profile = getRetailerProfile(identity.retailerKey);
      expect(profile).toEqual({
        retailerKey: 'gyomu_super',
        displayName: '業務スーパー',
        retailerFormat: 'supermarket',
        membershipRequired: false,
        bulkPurchaseFormat: true,
      });
      expect(merchantRaw).toBe('業務スーパー古川');
      expect(merchantNormalized).toBe('業務スーパー古川');
    });

    it('Costco aliases → costco profile', () => {
      const identity = deriveRetailerIdentity({
        merchantRaw: 'Costco Wholesale',
        merchantNormalized: 'コストコ',
      });
      expect(identity.retailerKey).toBe('costco');
      expect(getRetailerProfile(identity.retailerKey)?.retailerFormat).toBe(
        'warehouse_club'
      );
    });

    it('unresolved identity → null profile', () => {
      const identity = deriveRetailerIdentity({
        merchantRaw: '山田商店',
        merchantNormalized: '山田商店',
      });
      expect(identity.retailerKey).toBeNull();
      expect(getRetailerProfile(identity.retailerKey)).toBeNull();
    });
  });

  describe('contract — retailerFormat ≠ merchant_type / V1 eligibility', () => {
    it('Costco warehouse_club does not invent merchant_type=warehouse_club', () => {
      const profile = getRetailerProfile('costco');
      expect(profile?.retailerFormat).toBe('warehouse_club');

      // Receipt-level merchant_type remains existing enum only.
      const merchantType: MerchantType = 'supermarket';
      expect(merchantType).toBe('supermarket');
      expect(isV1SupportedMerchantType(merchantType)).toBe(true);
      expect(isV1SupportedMerchantType('warehouse_club' as MerchantType)).toBe(
        false
      );

      expect(
        isV1SupportedReceipt({
          merchant_type: 'supermarket',
          merchant_raw: 'コストコ',
          merchant_normalized: 'コストコ',
        })
      ).toBe(true);
    });

    it('profile metadata does not change V1 support matrix', () => {
      expect(isV1SupportedMerchantType('supermarket')).toBe(true);
      expect(isV1SupportedMerchantType('convenience')).toBe(true);
      expect(isV1SupportedMerchantType('other')).toBe(false);
      expect(isV1SupportedMerchantType('unknown')).toBe(false);
    });
  });

  describe('analytics freeze', () => {
    it('profile lookup does not change merchantAnalyticsKey', () => {
      const fixtures = [
        {
          merchant_raw: 'コストコ',
          merchant_normalized: 'コストコ',
        },
        {
          merchant_raw: '業務スーパー古川',
          merchant_normalized: null as string | null,
        },
        {
          merchant_raw: 'セブンイレブン 渋谷店',
          merchant_normalized: 'セブン-イレブン',
        },
      ];
      for (const f of fixtures) {
        const before = merchantAnalyticsKey(f);
        const identity = deriveRetailerIdentity({
          merchantRaw: f.merchant_raw,
          merchantNormalized: f.merchant_normalized,
        });
        getRetailerProfile(identity.retailerKey);
        expect(merchantAnalyticsKey(f)).toBe(before);
        expect(before).toBe(
          normalizeMerchantName(f.merchant_normalized || f.merchant_raw || '')
        );
      }
    });
  });
});
