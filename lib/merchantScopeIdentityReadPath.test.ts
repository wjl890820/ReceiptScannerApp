/**
 * H3-B2 phase 2 — Product Identity reads merchant scope before resolving.
 * Existing NULL receipts must keep the pre-H3-B2 merchant scope and MP id.
 */

import fs from 'fs';
import path from 'path';

import { identityObservationsFromPriceHistoryRows, resolveIdentityConsumerObservations } from './productIdentityConsumer';
import { buildPersonalProductEndpointInventory } from './personalProductEndpointInventory';
import {
  resolveReceiptItemIdentity,
  scopeMerchantKeyForIdentity,
} from './productIdentityResolver';
import { createMemoryProductIdentityStore } from './productIdentityStore';
import { resolveReceiptMerchantScope } from './merchantScopeGeneration';

const PRODUCT = '牛乳 1L';

function priceRow(overrides: {
  receiptId: string;
  merchantRaw?: string | null;
  merchantNormalized?: string | null;
  merchantScopeGeneration?: unknown;
  sourceIndex?: number;
}) {
  return {
    receiptId: overrides.receiptId,
    sourceIndex: overrides.sourceIndex ?? 0,
    occurredAt: 1_700_000_000_000,
    merchantRaw: overrides.merchantRaw ?? null,
    merchantNormalized: overrides.merchantNormalized ?? null,
    merchantScopeGeneration: overrides.merchantScopeGeneration,
    displayName: PRODUCT,
    lineTotal: 198,
    purchaseQuantity: 1,
  };
}

function legacyResolve(
  merchantNormalized: string | null,
  merchantRaw: string | null,
  receiptId: string
) {
  const evidence = merchantNormalized ?? merchantRaw ?? '';
  return resolveReceiptItemIdentity(
    {
      rawName: PRODUCT,
      merchantKey: evidence,
      receiptId,
      itemSourceIndex: 0,
      quantity: 1,
      lineTotal: 198,
    },
    createMemoryProductIdentityStore()
  );
}

function wiredQualified(row: ReturnType<typeof priceRow>) {
  const { qualified } = resolveIdentityConsumerObservations(
    identityObservationsFromPriceHistoryRows([row]),
    createMemoryProductIdentityStore()
  );
  return qualified[0]!;
}

describe('H3-B2 phase 2 identity read path', () => {
  const cases: {
    label: string;
    receiptId: string;
    merchantRaw: string | null;
    merchantNormalized: string | null;
  }[] = [
    {
      label: 'イオン',
      receiptId: 'receipt-096',
      merchantRaw: 'イオン古川店',
      merchantNormalized: 'イオン',
    },
    {
      label: 'イオン古川店 normalized to イオン',
      receiptId: 'aeon-branch',
      merchantRaw: 'イオン古川店',
      merchantNormalized: 'イオン',
    },
    {
      label: 'ヨークベニマル古川南店',
      receiptId: 'york-1',
      merchantRaw: 'ヨークベニマル古川南店',
      merchantNormalized: 'ヨークベニマル古川南店',
    },
    {
      label: '業務スーパー古川店',
      receiptId: 'gyomu-1',
      merchantRaw: '業務スーパー古川店',
      merchantNormalized: '業務スーパー古川店',
    },
    {
      label: 'ローソン',
      receiptId: 'lawson-1',
      merchantRaw: 'ローソン',
      merchantNormalized: 'ローソン',
    },
    {
      label: 'missing merchant',
      receiptId: 'missing-1',
      merchantRaw: null,
      merchantNormalized: null,
    },
  ];

  it.each(cases)(
    'NULL generation keeps the legacy scope and MerchantProduct id for $label',
    ({ receiptId, merchantRaw, merchantNormalized }) => {
      const legacy = legacyResolve(merchantNormalized, merchantRaw, receiptId);
      const wired = wiredQualified(
        priceRow({
          receiptId,
          merchantRaw,
          merchantNormalized,
          merchantScopeGeneration: null,
        })
      );
      const evidence = merchantNormalized ?? merchantRaw ?? '';
      expect(wired.merchantScopeKey).toBe(
        scopeMerchantKeyForIdentity(evidence, receiptId)
      );
      expect(wired.merchantProductId).toBe(legacy.link.merchantProductId);
      expect(wired.merchantScopeKey.startsWith('merchant:v2:')).toBe(false);
    }
  );

  it('treats an absent generation like the legacy formula', () => {
    const legacy = legacyResolve('イオン', 'イオン古川店', 'receipt-096');
    const wired = wiredQualified(
      priceRow({
        receiptId: 'receipt-096',
        merchantRaw: 'イオン古川店',
        merchantNormalized: 'イオン',
      })
    );
    expect(wired.merchantProductId).toBe(legacy.link.merchantProductId);
    expect(wired.merchantScopeKey).toBe('イオン');
  });

  it('shares one v2 MerchantProduct for the same observed store', () => {
    const { qualified } = resolveIdentityConsumerObservations(
      identityObservationsFromPriceHistoryRows([
        priceRow({
          receiptId: 'south-a',
          merchantRaw: 'ヨークベニマル古川南店',
          merchantNormalized: 'ヨークベニマル古川南店',
          merchantScopeGeneration: 2,
        }),
        priceRow({
          receiptId: 'south-b',
          merchantRaw: 'ヨークベニマル古川南店',
          merchantNormalized: 'ヨークベニマル古川南店',
          merchantScopeGeneration: 2,
        }),
      ])
    );
    expect(qualified[0]!.merchantKey).toBe(qualified[1]!.merchantKey);
    expect(qualified[0]!.merchantKey).toBe(
      'merchant:v2:store:ヨークベニマル古川南店'
    );
    expect(qualified[0]!.merchantProductId).toBe(qualified[1]!.merchantProductId);
  });

  it('splits v2 MerchantProducts across different observed stores', () => {
    const { qualified } = resolveIdentityConsumerObservations(
      identityObservationsFromPriceHistoryRows([
        priceRow({
          receiptId: 'south',
          merchantRaw: 'ヨークベニマル古川南店',
          merchantScopeGeneration: 2,
        }),
        priceRow({
          receiptId: 'other',
          merchantRaw: 'ヨークベニマル中新田店',
          merchantScopeGeneration: 2,
        }),
      ])
    );
    expect(qualified[0]!.merchantKey).not.toBe(qualified[1]!.merchantKey);
    expect(qualified[0]!.merchantProductId).not.toBe(
      qualified[1]!.merchantProductId
    );
  });

  it('isolates v2 chain-only receipts onto different MerchantProducts', () => {
    const { qualified } = resolveIdentityConsumerObservations(
      identityObservationsFromPriceHistoryRows([
        priceRow({
          receiptId: 'aeon-a',
          merchantRaw: 'イオン',
          merchantNormalized: 'イオン',
          merchantScopeGeneration: 2,
        }),
        priceRow({
          receiptId: 'aeon-b',
          merchantRaw: 'イオン',
          merchantNormalized: 'イオン',
          merchantScopeGeneration: 2,
        }),
      ])
    );
    expect(qualified[0]!.merchantKey).toBe(
      'merchant:v2:unknown-store:receipt:aeon-a'
    );
    expect(qualified[1]!.merchantKey).toBe(
      'merchant:v2:unknown-store:receipt:aeon-b'
    );
    expect(qualified[0]!.merchantProductId).not.toBe(
      qualified[1]!.merchantProductId
    );
  });

  it('keeps v1 and v2 namespaces apart for the same printed store', () => {
    const v1 = wiredQualified(
      priceRow({
        receiptId: 'york-v1',
        merchantRaw: 'ヨークベニマル古川南店',
        merchantNormalized: 'ヨークベニマル古川南店',
        merchantScopeGeneration: null,
      })
    );
    const v2 = wiredQualified(
      priceRow({
        receiptId: 'york-v2',
        merchantRaw: 'ヨークベニマル古川南店',
        merchantNormalized: 'ヨークベニマル古川南店',
        merchantScopeGeneration: 2,
      })
    );
    expect(v1.merchantScopeKey).toBe('ヨークベニマル古川南店');
    expect(v2.merchantKey.startsWith('merchant:v2:')).toBe(true);
    expect(v1.merchantProductId).not.toBe(v2.merchantProductId);
  });

  it.each(['2', 1, 3, Number.NaN])(
    'does not give generation %p a v2 MerchantProduct',
    (generation) => {
      const wired = wiredQualified(
        priceRow({
          receiptId: 'bad',
          merchantRaw: 'ヨークベニマル古川南店',
          merchantNormalized: 'ヨークベニマル古川南店',
          merchantScopeGeneration: generation,
        })
      );
      const legacy = legacyResolve(
        'ヨークベニマル古川南店',
        'ヨークベニマル古川南店',
        'bad'
      );
      expect(wired.merchantScopeKey.startsWith('merchant:v2:')).toBe(false);
      expect(wired.merchantProductId).toBe(legacy.link.merchantProductId);
    }
  );

  it('keeps a legacy cached link and refuses it for a v2 observation', () => {
    const store = createMemoryProductIdentityStore();
    const specific = 'コカ・コーラ 500ml';
    const row = {
      ...priceRow({
        receiptId: 'r-cache',
        merchantRaw: 'ヨークベニマル古川南店',
        merchantNormalized: 'ヨークベニマル古川南店',
        merchantScopeGeneration: null,
      }),
      displayName: specific,
    };
    const first = resolveIdentityConsumerObservations(
      identityObservationsFromPriceHistoryRows([row]),
      store
    );
    const again = resolveReceiptItemIdentity(
      {
        rawName: specific,
        merchantKey: 'ヨークベニマル古川南店',
        receiptId: 'r-cache',
        itemSourceIndex: 0,
        quantity: 1,
        lineTotal: 198,
      },
      store
    );
    expect(again.reason).toBe('cache_hit');
    expect(again.link.merchantProductId).toBe(
      first.qualified[0]!.merchantProductId
    );

    const v2Scope = resolveReceiptMerchantScope({
      receiptId: 'r-cache',
      merchantRaw: 'ヨークベニマル古川南店',
      merchantNormalized: 'ヨークベニマル古川南店',
      merchantScopeGeneration: 2,
    });
    const v2 = resolveReceiptItemIdentity(
      {
        rawName: specific,
        merchantKey: v2Scope.scopeKey,
        receiptId: 'r-cache',
        itemSourceIndex: 0,
        quantity: 1,
        lineTotal: 198,
      },
      store
    );
    expect(v2.reason).not.toBe('cache_hit');
    expect(v2.link.merchantProductId).not.toBe(again.link.merchantProductId);
  });

  it('uses the same v2 scope inside personal product inventory', () => {
    const legacy = buildPersonalProductEndpointInventory({
      ownerKey: 'user:phase2',
      receipts: [],
      decisionRows: [],
      sourceRows: [
        {
          receiptId: 'inv-1',
          itemId: 'i1',
          sourceIndex: 0,
          occurredAt: 1_700_000_000_000,
          merchantRaw: 'イオン古川店',
          merchantNormalized: 'イオン',
          merchantScopeGeneration: null,
          displayName: PRODUCT,
          rawName: PRODUCT,
          lineTotal: 198,
          purchaseQuantity: 1,
          skuKey: null,
          brand: null,
        },
      ],
    });
    expect(legacy.status).toBe('ready');
    if (legacy.status !== 'ready') return;
    const item = legacy.inventory.itemsByRowKey.get('inv-1:0');
    expect(item?.merchantScopeKey).toBe('イオン');
    expect(item?.merchantProductId).toBe(
      legacyResolve('イオン', 'イオン古川店', 'inv-1').link.merchantProductId
    );

    const isolated = buildPersonalProductEndpointInventory({
      ownerKey: 'user:phase2',
      receipts: [],
      decisionRows: [],
      sourceRows: [
        {
          receiptId: 'inv-a',
          itemId: 'ia',
          sourceIndex: 0,
          occurredAt: 1,
          merchantRaw: 'イオン',
          merchantNormalized: 'イオン',
          merchantScopeGeneration: 2,
          displayName: PRODUCT,
          rawName: PRODUCT,
          lineTotal: 198,
          purchaseQuantity: 1,
          skuKey: null,
          brand: null,
        },
        {
          receiptId: 'inv-b',
          itemId: 'ib',
          sourceIndex: 0,
          occurredAt: 2,
          merchantRaw: 'イオン',
          merchantNormalized: 'イオン',
          merchantScopeGeneration: 2,
          displayName: PRODUCT,
          rawName: PRODUCT,
          lineTotal: 198,
          purchaseQuantity: 1,
          skuKey: null,
          brand: null,
        },
      ],
    });
    expect(isolated.status).toBe('ready');
    if (isolated.status !== 'ready') return;
    const a = isolated.inventory.itemsByRowKey.get('inv-a:0');
    const b = isolated.inventory.itemsByRowKey.get('inv-b:0');
    expect(a?.merchantProductId).not.toBe(b?.merchantProductId);
    expect(a?.merchantScopeKey).not.toBe(item?.merchantScopeKey);
  });

  it('does not assign a literal generation 2 outside the save constant', () => {
    const root = path.resolve(__dirname);
    for (const file of [
      'db.ts',
      'productIdentityConsumer.ts',
      'productIdentityResolver.ts',
      'productPriceHistory.ts',
      'personalProductEndpointInventory.ts',
      'productHistory.ts',
      'repeatProductProfile.ts',
      'engagementMilestones.ts',
      'cloudBackupPayload.ts',
      'cloudRestorePayload.ts',
    ]) {
      expect(fs.readFileSync(path.join(root, file), 'utf8')).not.toMatch(
        /merchant_scope_generation\s*=\s*2/
      );
    }
  });
});
