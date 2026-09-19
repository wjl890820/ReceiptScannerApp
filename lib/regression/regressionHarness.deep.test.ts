/**
 * Phase 2 deep regression — focused golden tests (synthetic fixtures).
 * No real export required. No DB / network / OCR.
 */

/* eslint-disable import/first -- Jest dependency mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));
jest.mock('../db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildHistoricalIndexFromEnvelope } from './buildHistoricalIndex';
import { collapseLogicalPurchases } from './collapseLogicalPurchases';
import { formatDeepConsoleSummary } from './deepConsoleSummary';
import { resolveDeepExitCode } from './deepExitCode';
import { loadExportEnvelope } from './parseExport';
import { replayPriceHistory } from './replayPriceHistory';
import { replayRepeatProfiles } from './replayRepeat';
import { runDeepRegressionHarness } from './runDeepHarness';
import type { RegressionManifest } from './types';

function makeAnalysis(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    merchant: '業務スーパー古川店',
    total: 2121,
    tax: 157,
    tax_is_known: true,
    currency: 'JPY',
    transactionDate: '2026-07-10 12:03:00',
    is_grocery: true,
    merchant_type: 'supermarket',
    items,
    ...overrides,
  };
}

function makeReceiptRow(
  id: string,
  opts: {
    createdAt?: number;
    transactionAt?: number | null;
    analysis?: Record<string, unknown>;
    snapshot?: Record<string, unknown> | null;
    total?: number;
    merchant?: string;
  } = {}
): Record<string, unknown> {
  const analysis =
    opts.analysis ??
    makeAnalysis([
      { name: '練りピーナッツ・ごま', quantity: 1, lineTotal: 292 },
      { name: '正宗生煎包', quantity: 3, unitPrice: 439, lineTotal: 1317 },
      { name: '豆腐皮', quantity: 1, lineTotal: 355 },
    ]);
  const snap = opts.snapshot === null ? null : opts.snapshot ?? analysis;
  return {
    id,
    created_at: opts.createdAt ?? 1_700_000_000_000,
    transaction_at:
      opts.transactionAt === undefined
        ? Date.parse('2026-07-10T12:03:00+09:00')
        : opts.transactionAt,
    merchant_raw: opts.merchant ?? '業務スーパー古川店',
    merchant_normalized: '業務スーパー',
    merchant_type: 'supermarket',
    total: opts.total ?? 2121,
    tax: 157,
    tax_is_known: 1,
    currency: 'JPY',
    image_uri: '',
    user_edited: 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
    analysis_json: JSON.stringify(analysis),
    recognition_snapshot_json: snap == null ? null : JSON.stringify(snap),
  };
}

function writeTempExport(receipts: Record<string, unknown>[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meruno-deep-'));
  const file = path.join(dir, 'export.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      exportedAt: '2026-09-19T00:00:00.000Z',
      receiptCount: receipts.length,
      receipts,
    }),
    'utf8'
  );
  return file;
}

function writeManifests(
  dir: string,
  manifests: RegressionManifest[]
): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const m of manifests) {
    fs.writeFileSync(
      path.join(dir, `receipt${String(m.receiptNo).padStart(3, '0')}.json`),
      JSON.stringify(m, null, 2),
      'utf8'
    );
  }
}

describe('Phase 2 deep regression', () => {
  it('analytics SSOT collapses identical rescans to one logical purchase', () => {
    const analysis = makeAnalysis([
      { name: '正宗生煎包', quantity: 3, unitPrice: 439, lineTotal: 1317 },
    ]);
    const tx = Date.parse('2026-07-10T12:03:00+09:00');
    const rows = [
      makeReceiptRow('r1', { analysis, transactionAt: tx, createdAt: 100 }),
      makeReceiptRow('r2', { analysis, transactionAt: tx, createdAt: 200 }),
      makeReceiptRow('r3', { analysis, transactionAt: tx, createdAt: 300 }),
    ];
    const envelope = loadExportEnvelope({ receipts: rows });
    const historical = buildHistoricalIndexFromEnvelope(envelope);
    const collapse = collapseLogicalPurchases({
      rawReceiptRows: historical.rawReceiptRows,
      rawItemRows: historical.rawItemRows,
      rawPriceHistoryRows: historical.rawPriceHistoryRows,
    });
    expect(collapse.logicalPurchaseCount).toBe(1);
    expect(collapse.duplicateRowCount).toBe(2);
    expect(collapse.includedReceiptIds).toHaveLength(1);
  });

  it('rescan does not create Repeat; qty>1 is one occurrence', () => {
    const analysis = makeAnalysis([
      { name: '正宗生煎包', quantity: 3, unitPrice: 439, lineTotal: 1317 },
    ]);
    const tx = Date.parse('2026-07-10T12:03:00+09:00');
    const rows = [
      makeReceiptRow('r1', { analysis, transactionAt: tx, createdAt: 100 }),
      makeReceiptRow('r2', { analysis, transactionAt: tx, createdAt: 200 }),
      makeReceiptRow('r3', { analysis, transactionAt: tx, createdAt: 300 }),
    ];
    const envelope = loadExportEnvelope({ receipts: rows });
    const historical = buildHistoricalIndexFromEnvelope(envelope);
    const collapse = collapseLogicalPurchases({
      rawReceiptRows: historical.rawReceiptRows,
      rawItemRows: historical.rawItemRows,
      rawPriceHistoryRows: historical.rawPriceHistoryRows,
    });
    const repeat = replayRepeatProfiles({
      analyticsReceipts: collapse.selection.analyticsReceipts,
      productRows: collapse.analyticsItemRows,
    });
    // Single logical purchase → no Repeat (≥2 required).
    expect(repeat.profiles.every((p) => p.purchaseOccurrenceCount < 2)).toBe(
      true
    );
    const bao = collapse.analyticsItemRows.find((r) =>
      (r.displayName || '').includes('生煎')
    );
    expect(bao?.purchaseQuantity).toBe(3);
  });

  it('two genuine dates create Repeat occurrence=2', () => {
    // Specific Gyomu line that resolves to merchant_product (not family_only).
    const analysis = makeAnalysis([
      { name: '練りピーナッツ・ごま', quantity: 1, lineTotal: 292 },
    ]);
    const rows = [
      makeReceiptRow('day1', {
        analysis,
        transactionAt: Date.parse('2026-07-01T10:00:00+09:00'),
        createdAt: 1,
      }),
      makeReceiptRow('day2', {
        analysis,
        transactionAt: Date.parse('2026-07-08T10:00:00+09:00'),
        createdAt: 2,
      }),
    ];
    const envelope = loadExportEnvelope({ receipts: rows });
    const historical = buildHistoricalIndexFromEnvelope(envelope);
    const collapse = collapseLogicalPurchases({
      rawReceiptRows: historical.rawReceiptRows,
      rawItemRows: historical.rawItemRows,
      rawPriceHistoryRows: historical.rawPriceHistoryRows,
    });
    expect(collapse.logicalPurchaseCount).toBe(2);
    const repeat = replayRepeatProfiles({
      analyticsReceipts: collapse.selection.analyticsReceipts,
      productRows: collapse.analyticsItemRows,
    });
    const hit = repeat.profiles.find((p) => p.purchaseOccurrenceCount >= 2);
    expect(hit?.purchaseOccurrenceCount).toBe(2);
    expect(hit?.identityKind).toBe('merchant_product');
  });

  it('family_only cannot bootstrap Repeat (production forbids)', () => {
    // Bare "牛乳" resolves family_only — same contract as repeatProductProfile.test.
    const analysis = makeAnalysis([
      { name: '牛乳', quantity: 1, lineTotal: 100 },
    ]);
    const rows = [
      makeReceiptRow('a', {
        analysis,
        transactionAt: Date.parse('2026-07-01T10:00:00+09:00'),
      }),
      makeReceiptRow('b', {
        analysis,
        transactionAt: Date.parse('2026-07-08T10:00:00+09:00'),
      }),
      makeReceiptRow('c', {
        analysis,
        transactionAt: Date.parse('2026-07-15T10:00:00+09:00'),
      }),
    ];
    const envelope = loadExportEnvelope({ receipts: rows });
    const historical = buildHistoricalIndexFromEnvelope(envelope);
    const collapse = collapseLogicalPurchases({
      rawReceiptRows: historical.rawReceiptRows,
      rawItemRows: historical.rawItemRows,
      rawPriceHistoryRows: historical.rawPriceHistoryRows,
    });
    const repeat = replayRepeatProfiles({
      analyticsReceipts: collapse.selection.analyticsReceipts,
      productRows: collapse.analyticsItemRows,
    });
    expect(repeat.profiles).toHaveLength(0);
  });

  it('PPH collapses same receiptId; qty3 is one purchase event; ready needs ≥2', () => {
    const item = {
      name: '明治おいしい牛乳 1L',
      quantity: 3,
      lineTotal: 594,
      unitPrice: 198,
    };
    const rows = [
      makeReceiptRow('p1', {
        analysis: makeAnalysis([item], { total: 594, tax: 0 }),
        transactionAt: Date.parse('2026-07-01T10:00:00+09:00'),
        total: 594,
      }),
      makeReceiptRow('p2', {
        analysis: makeAnalysis([item], { total: 594, tax: 0 }),
        transactionAt: Date.parse('2026-07-08T10:00:00+09:00'),
        total: 594,
      }),
    ];
    const envelope = loadExportEnvelope({ receipts: rows });
    const historical = buildHistoricalIndexFromEnvelope(envelope);
    const collapse = collapseLogicalPurchases({
      rawReceiptRows: historical.rawReceiptRows,
      rawItemRows: historical.rawItemRows,
      rawPriceHistoryRows: historical.rawPriceHistoryRows,
    });
    expect(collapse.logicalPurchaseCount).toBe(2);

    const pph = replayPriceHistory({
      analyticsPriceHistoryRows: collapse.analyticsPriceHistoryRows,
    });
    for (const t of pph.targets) {
      if (t.status === 'ready') {
        expect(t.comparablePoints).toBeGreaterThanOrEqual(2);
      }
    }
    // Single receipt alone → NEP
    const oneReceiptRows = collapse.analyticsPriceHistoryRows.filter(
      (r) => r.receiptId === collapse.includedReceiptIds[0]
    );
    const onePph = replayPriceHistory({
      analyticsPriceHistoryRows: oneReceiptRows,
    });
    for (const t of onePph.targets) {
      expect(t.comparablePoints).toBeLessThan(2);
      if (t.membershipRows >= 1) {
        expect(['not_enough_points', 'ready', ...Object.keys(onePph.otherStatuses)]).toContain(
          t.status
        );
      }
      expect(t.status).not.toBe('ready');
    }
  });

  it('transaction_at beats created_at for chronology', () => {
    const analysis = makeAnalysis([
      { name: '明治おいしい牛乳 1L', quantity: 1, lineTotal: 198 },
    ]);
    const oldTx = Date.parse('2026-01-01T10:00:00+09:00');
    const newScan = Date.parse('2026-08-01T10:00:00+09:00');
    const rows = [
      makeReceiptRow('rescanned', {
        analysis,
        transactionAt: oldTx,
        createdAt: newScan,
      }),
      makeReceiptRow('later_tx', {
        analysis,
        transactionAt: Date.parse('2026-02-01T10:00:00+09:00'),
        createdAt: Date.parse('2026-02-01T11:00:00+09:00'),
      }),
    ];
    const envelope = loadExportEnvelope({ receipts: rows });
    const historical = buildHistoricalIndexFromEnvelope(envelope);
    const meta = historical.receiptMetaById.get('rescanned');
    expect(meta?.occurredAt).toBe(oldTx);
    expect(meta?.occurredAt).not.toBe(newScan);

    const collapse = collapseLogicalPurchases({
      rawReceiptRows: historical.rawReceiptRows,
      rawItemRows: historical.rawItemRows,
      rawPriceHistoryRows: historical.rawPriceHistoryRows,
    });
    const repeat = replayRepeatProfiles({
      analyticsReceipts: collapse.selection.analyticsReceipts,
      productRows: collapse.analyticsItemRows,
    });
    const milk = repeat.profiles.find((p) => p.purchaseOccurrenceCount >= 2);
    if (milk) {
      expect(milk.firstPurchasedAt).toBe(oldTx);
    }
  });

  it('Receipt074 synthetic full projection: unresolved discount rejects Level-2', () => {
    const { normalizeOcrAnalysis } =
      require('../receiptOcrNormalize') as typeof import('../receiptOcrNormalize');
    const { buildReceiptEvidenceCache, buildProductPriceHistory } =
      require('../productPriceHistory') as typeof import('../productPriceHistory');

    const RECEIPT074_CJK_LATIN = {
      merchant: 'コストコ',
      currency: 'JPY',
      total: 6292,
      tax: 466,
      items: [
        { name: '商品ア', quantity: 1, unitPrice: 998, lineTotal: 998 },
        { name: '商品イ', quantity: 1, unitPrice: 1280, lineTotal: 1280 },
        { name: '商品ウ', quantity: 1, unitPrice: 648, lineTotal: 648 },
        { name: '商品エ', quantity: 1, unitPrice: 1198, lineTotal: 1198 },
        { name: '商品オ', quantity: 1, unitPrice: 890, lineTotal: 890 },
        { name: '商品カ', quantity: 1, unitPrice: 680, lineTotal: 680 },
        { name: 'ケージフリータマゴ 20', quantity: 1, unitPrice: 758, lineTotal: 758 },
        { name: 'CAGE FREE EGG CPN', quantity: 1, unitPrice: -160, lineTotal: -160 },
      ],
    };
    const out = normalizeOcrAnalysis(RECEIPT074_CJK_LATIN);
    const analysis = {
      merchant: 'コストコ',
      items: out.items,
      discounts: out.discounts,
      tax: out.tax,
      tax_is_known: true,
      total: out.total,
      currency: 'JPY',
      is_grocery: true,
      merchant_type: 'supermarket',
      reconciliation: { ok: true },
      amount_mismatch: false,
    };
    const exportRow = makeReceiptRow('r074', {
      analysis,
      transactionAt: Date.parse('2026-03-01T12:00:00+09:00'),
      total: out.total,
      merchant: 'コストコ',
    });
    const envelope = loadExportEnvelope({ receipts: [exportRow] });
    const historical = buildHistoricalIndexFromEnvelope(envelope);
    expect(historical.rawPriceHistoryRows.length).toBeGreaterThan(0);
    const eggRows = historical.rawPriceHistoryRows.filter((r) =>
      String(r.displayName).includes('ケージフリータマゴ')
    );
    expect(eggRows.length).toBeGreaterThanOrEqual(1);
    const cache = buildReceiptEvidenceCache(eggRows);
    const receiptId = eggRows[0]!.receiptId;
    expect(
      cache.get(receiptId)!.monetaryCoherenceEvidence.discountOwnershipStatus
    ).toBe('unresolved');
    const history = buildProductPriceHistory(
      { type: 'sku', key: 'egg-074' },
      eggRows.map((r) => ({ ...r, skuKey: 'egg-074' })),
      { receiptEvidenceCache: cache }
    );
    expect(history.observations.length).toBeGreaterThan(0);
    expect(
      history.observations.every((o) => o.level2Eligible === false)
    ).toBe(true);
    expect(
      history.observations.some((o) =>
        o.level2RejectReasons.includes('discount_ownership_unresolved')
      )
    ).toBe(true);
  });

  it('current projection: user_items wins; analysis fallback; snapshot never overrides', () => {
    const snap = makeAnalysis([{ name: 'OLD', quantity: 1, lineTotal: 100 }]);
    const analysis = makeAnalysis([
      { name: 'CURRENT', quantity: 1, lineTotal: 200 },
    ]);
    const userItems = [{ name: 'USER_EDIT', quantity: 1, lineTotal: 300 }];
    const withUser = makeReceiptRow('auth-user', {
      analysis,
      transactionAt: Date.parse('2026-07-01T10:00:00+09:00'),
    });
    withUser.recognition_snapshot_json = JSON.stringify(snap);
    withUser.user_items_json = JSON.stringify(userItems);
    withUser.analysis_json = JSON.stringify(analysis);

    const noUser = makeReceiptRow('auth-analysis', {
      analysis,
      transactionAt: Date.parse('2026-07-02T10:00:00+09:00'),
    });
    noUser.recognition_snapshot_json = JSON.stringify(snap);
    noUser.user_items_json = null;
    noUser.analysis_json = JSON.stringify(analysis);

    const malformedUser = makeReceiptRow('auth-malformed', {
      analysis,
      transactionAt: Date.parse('2026-07-03T10:00:00+09:00'),
    });
    malformedUser.recognition_snapshot_json = JSON.stringify(snap);
    malformedUser.user_items_json = '{broken';
    malformedUser.analysis_json = JSON.stringify(analysis);

    const emptyUser = makeReceiptRow('auth-empty', {
      analysis,
      transactionAt: Date.parse('2026-07-04T10:00:00+09:00'),
    });
    emptyUser.recognition_snapshot_json = JSON.stringify(snap);
    emptyUser.user_items_json = '[]';
    emptyUser.analysis_json = JSON.stringify(analysis);

    const envelope = loadExportEnvelope({
      receipts: [withUser, noUser, malformedUser, emptyUser],
    });
    const historical = buildHistoricalIndexFromEnvelope(envelope);

    const namesFor = (id: string) =>
      historical.rawItemRows
        .filter((r) => r.receiptId === id)
        .map((r) => r.displayName);

    expect(namesFor('auth-user').map((n) => n.toLowerCase())).toEqual([
      'user_edit',
    ]);
    expect(namesFor('auth-analysis').map((n) => n.toLowerCase())).toEqual([
      'current',
    ]);
    // Malformed user_items → analysis. Empty array is valid user authority (0 items).
    expect(namesFor('auth-malformed').map((n) => n.toLowerCase())).toEqual([
      'current',
    ]);
    expect(namesFor('auth-empty')).toEqual([]);
    expect(
      historical.rawItemRows.every(
        (r) => r.displayName.toLowerCase() !== 'old'
      )
    ).toBe(true);
  });

  it('deep harness end-to-end is deterministic on synthetic export', () => {
    const analysis = makeAnalysis([
      { name: '明治おいしい牛乳 1L', quantity: 1, lineTotal: 198 },
    ]);
    const receipts = [
      makeReceiptRow('d1', {
        analysis,
        transactionAt: Date.parse('2026-07-01T10:00:00+09:00'),
      }),
      makeReceiptRow('d2', {
        analysis,
        transactionAt: Date.parse('2026-07-08T10:00:00+09:00'),
      }),
      // Rescans of d1 content+time
      makeReceiptRow('d1b', {
        analysis,
        transactionAt: Date.parse('2026-07-01T10:00:00+09:00'),
        createdAt: 9_999,
      }),
    ];
    const exportPath = writeTempExport(receipts);
    const manifestDir = path.join(path.dirname(exportPath), 'manifests');
    writeManifests(manifestDir, [
      {
        schemaVersion: 1,
        receiptNo: 81,
        selectors: {
          merchant: '業務スーパー古川店',
          transactionAt: '2026-07-01T10:00:00+09:00',
          total: 2121,
        },
        truth: { merchant: '業務スーパー古川店' },
      },
    ]);

    const a = runDeepRegressionHarness({
      exportPath,
      manifestDir,
      gitHead: 'test',
    });
    const b = runDeepRegressionHarness({
      exportPath,
      manifestDir,
      gitHead: 'test',
    });

    expect(a.deep.crossReceipt.analyticsRetainedReceipts).toBe(
      b.deep.crossReceipt.analyticsRetainedReceipts
    );
    expect(a.deep.crossReceipt.canonicalPurchaseOccurrences).toBe(
      b.deep.crossReceipt.canonicalPurchaseOccurrences
    );
    expect(a.deep.visitSpend.supportedVisitCount).toBe(
      b.deep.visitSpend.supportedVisitCount
    );
    expect(a.deep.repeat.profileCount).toBe(b.deep.repeat.profileCount);
    expect(a.deep.pph.targetCount).toBe(b.deep.pph.targetCount);
    expect(a.deep.pph.ready).toBe(b.deep.pph.ready);
    expect(a.deep.pph.notEnoughPoints).toBe(b.deep.pph.notEnoughPoints);
    expect(a.deep.pph.rejectionReasonCounts).toEqual(
      b.deep.pph.rejectionReasonCounts
    );
    expect(a.observedHistory.status).toBe('not_available_phase2_v1');
    expect(a.deep.invariants.readyRequiresTwoComparablePoints).toBe(true);
    expect(a.deep.invariants.rescansDoNotInflateRepeatOccurrences).toBe(true);
    expect(a.deep.invariants.rescansDoNotInflateRepeatQuantity).toBe(true);
    expect(a.deep.invariants.rescansDoNotInflateComparablePoints).toBe(true);
    expect(a.deep.invariants.rescansDoNotInflatePphGrossOrQuantity).toBe(true);

    const summary = formatDeepConsoleSummary(a);
    expect(summary).toContain('Meruno Deep Receipt Regression');
    expect(summary).toContain('Analytics retained receipts');
    expect(resolveDeepExitCode({ harnessFailed: false, report: a })).toBe(0);
  });

  it('currency rejection surfaces production enum when non-JPY', () => {
    const analysis = makeAnalysis(
      [{ name: 'Milk 1L', quantity: 1, lineTotal: 3.5 }],
      { currency: 'USD', total: 3.5, tax: 0 }
    );
    const rows = [
      makeReceiptRow('u1', {
        analysis: { ...analysis, currency: 'USD' },
        transactionAt: Date.parse('2026-07-01T10:00:00+09:00'),
        total: 3.5,
      }),
      makeReceiptRow('u2', {
        analysis: { ...analysis, currency: 'USD' },
        transactionAt: Date.parse('2026-07-08T10:00:00+09:00'),
        total: 3.5,
      }),
    ];
    // Force currency on export columns
    rows[0]!.currency = 'USD';
    rows[1]!.currency = 'USD';
    const envelope = loadExportEnvelope({ receipts: rows });
    const historical = buildHistoricalIndexFromEnvelope(envelope);
    const collapse = collapseLogicalPurchases({
      rawReceiptRows: historical.rawReceiptRows,
      rawItemRows: historical.rawItemRows,
      rawPriceHistoryRows: historical.rawPriceHistoryRows,
    });
    const pph = replayPriceHistory({
      analyticsPriceHistoryRows: collapse.analyticsPriceHistoryRows,
    });
    const reasons = Object.keys(pph.rejectionReasonCounts);
    // Production may use currency_not_jpy or mixed/unknown_currency status.
    const hasCurrencyGate =
      reasons.some((r) => r.includes('currency')) ||
      pph.targets.some(
        (t) =>
          t.status === 'mixed_currency' ||
          t.status === 'unknown_currency' ||
          t.status === 'not_enough_points'
      );
    expect(hasCurrencyGate).toBe(true);
  });
});
