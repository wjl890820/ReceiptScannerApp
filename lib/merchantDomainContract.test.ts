/**
 * R1-B1 — Merchant domain contract freeze (tests only).
 * Locks current semantics; does not expand chain normalization.
 *
 * SSOT: docs/merchant-domain-contract.md
 */

import {
  aggregateV1MerchantSpend,
  merchantAnalyticsKey,
} from './merchantAnalytics';
import {
  isV1SupportedMerchantType,
  isV1SupportedReceipt,
  type MerchantType,
} from './merchantType';
import { normalizeMerchantName } from './productNormalizer';
import { canonicalizeMerchantChain } from './receiptOcrNormalize';
import * as fs from 'fs';
import * as path from 'path';

describe('R1-B1 merchant domain contract', () => {
  describe('merchantAnalyticsKey — sole V1 aggregation identity', () => {
    it('prefers merchant_normalized over merchant_raw over empty', () => {
      expect(
        merchantAnalyticsKey({
          merchant_normalized: 'セブン-イレブン',
          merchant_raw: 'セブンイレブン 渋谷店',
        })
      ).toBe(normalizeMerchantName('セブン-イレブン'));

      expect(
        merchantAnalyticsKey({
          merchant_normalized: null,
          merchant_raw: 'ローソン 駅前店',
        })
      ).toBe(normalizeMerchantName('ローソン 駅前店'));

      expect(
        merchantAnalyticsKey({
          merchant_normalized: null,
          merchant_raw: null,
        })
      ).toBe(normalizeMerchantName(''));
    });

    it('always routes through normalizeMerchantName', () => {
      const normalized = canonicalizeMerchantChain('7-Eleven');
      const key = merchantAnalyticsKey({
        merchant_raw: '7-Eleven',
        merchant_normalized: normalized,
      });
      expect(key).toBe(normalizeMerchantName(normalized));
    });

    it('does not invent a second aggregation path from store_* fields', () => {
      const withStoreMirror = {
        merchant_raw: '業務スーパー古川店',
        merchant_normalized: null as string | null,
        // Intentionally ignored if ever passed — key API only reads merchant_* .
        store_raw: 'SHOULD_NOT_AFFECT_KEY',
        store_normalized: 'SHOULD_NOT_AFFECT_KEY',
      };
      expect(
        merchantAnalyticsKey(withStoreMirror)
      ).toBe(normalizeMerchantName('業務スーパー古川店'));
    });
  });

  describe('raw observation vs normalized', () => {
    it('keeps raw distinct while analytics prefers normalized when present', () => {
      const merchant_raw = 'セブンイレブン 渋谷店';
      const merchant_normalized = canonicalizeMerchantChain(merchant_raw);
      expect(merchant_normalized).toBe('セブン-イレブン');
      expect(merchant_raw).not.toBe(merchant_normalized);

      const key = merchantAnalyticsKey({ merchant_raw, merchant_normalized });
      expect(key).toBe(normalizeMerchantName(merchant_normalized));
      expect(key).not.toBe(normalizeMerchantName(merchant_raw));

      // Display contract (History): raw remains available for UI.
      const display = merchant_raw || merchant_normalized;
      expect(display).toBe(merchant_raw);
    });
  });

  describe('merchant_type V1 eligibility', () => {
    const cases: Array<{ type: MerchantType; supported: boolean }> = [
      { type: 'supermarket', supported: true },
      { type: 'convenience', supported: true },
      { type: 'other', supported: false },
      { type: 'unknown', supported: false },
    ];

    it.each(cases)('$type → supported=$supported', ({ type, supported }) => {
      expect(isV1SupportedMerchantType(type)).toBe(supported);
      expect(
        isV1SupportedReceipt({
          merchant_type: type,
          merchant_raw: 'fixture',
          analysis_json: '{}',
        })
      ).toBe(supported);
    });

    it('unsupported receipt remains a valid domain record (still “saveable”)', () => {
      const unsupported = {
        id: 'recv-other-1',
        merchant_type: 'other' as const,
        merchant_raw: 'マツキヨ',
        merchant_normalized: 'マツキヨ',
        analysis_json: '{}',
        total: 1200,
      };
      expect(isV1SupportedReceipt(unsupported)).toBe(false);
      // Valid receipt object: required observation fields present; not dropped from storage model.
      expect(unsupported.id).toBeTruthy();
      expect(unsupported.merchant_raw).toBeTruthy();
      expect(unsupported.total).toBeGreaterThan(0);
      expect(aggregateV1MerchantSpend([unsupported])).toHaveLength(0);
    });
  });

  describe('merchant_type is not a grocery boolean', () => {
    it('convenience is V1-supported (unlike supermarket-only grocery semantics)', () => {
      expect(isV1SupportedMerchantType('convenience')).toBe(true);
      expect(isV1SupportedMerchantType('supermarket')).toBe(true);
      // other/unknown stay out of V1 shopping universe
      expect(isV1SupportedMerchantType('other')).toBe(false);
      expect(isV1SupportedMerchantType('unknown')).toBe(false);
    });
  });

  describe('store_* legacy placeholder status', () => {
    it('production merchant analytics modules do not treat store_* as identity', () => {
      const stripComments = (src: string) =>
        src
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[ \t])\/\/.*$/gm, '$1');
      const analyticsSrc = stripComments(
        fs.readFileSync(path.join(__dirname, 'merchantAnalytics.ts'), 'utf8')
      );
      const typeSrc = stripComments(
        fs.readFileSync(path.join(__dirname, 'merchantType.ts'), 'utf8')
      );
      expect(analyticsSrc).not.toMatch(/\bstore_raw\b/);
      expect(analyticsSrc).not.toMatch(/\bstore_normalized\b/);
      expect(typeSrc).not.toMatch(/\bstore_raw\b/);
      expect(typeSrc).not.toMatch(/\bstore_normalized\b/);
    });

    it('db save mirrors merchant_* into store_* (placeholder, not branch extraction)', () => {
      const dbSrc = fs.readFileSync(path.join(__dirname, 'db.ts'), 'utf8');
      expect(dbSrc).toMatch(/storeRaw\s*=\s*merchantRawTrimmed/);
      expect(dbSrc).toMatch(/storeNormalized\s*=\s*merchantNormalized/);
    });
  });
});
