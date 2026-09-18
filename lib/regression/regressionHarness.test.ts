/**
 * Phase 1 offline snapshot regression harness — unit tests (synthetic fixtures only).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { formatConsoleSummary } from './consoleSummary';
import { runDeterministicChecks } from './deterministicChecks';
import { resolveExitCode, collectTruthRegressions } from './exitCode';
import {
  gradeAgainstTruth,
  gradeNoTruthDelta,
  gradeScalarField,
  compareMerchants,
} from './gradeTruth';
import {
  matchManifestToRows,
  pickRepresentativeRow,
  merchantCompatible,
  classifyLineAmountsFingerprint,
} from './matchManifest';
import { receiptTimestampsEqual } from './dateCompare';
import {
  loadExportEnvelope,
  loadHistoricalRow,
  parseNestedJsonObject,
  resolveBaselinePayload,
} from './parseExport';
import { projectCanonicalFromPayload } from './projectCanonical';
import { containsSensitiveKeys, redactForReport } from './privacy';
import { runRegressionHarness } from './runHarness';
import type { LoadedHistoricalRow, RegressionManifest } from './types';

function makeRow(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'row-1',
    created_at: 1_700_000_000_000,
    transaction_at: Date.parse('2026-07-10T12:03:00+09:00'),
    merchant_raw: '業務スーパー古川店',
    merchant_normalized: '業務スーパー',
    total: 2121,
    tax: 157,
    currency: 'JPY',
    image_uri: '',
    user_id: 'secret-user',
    installation_id: 'secret-install',
    analysis_json: JSON.stringify({
      merchant: '業務スーパー古川店',
      total: 2121,
      tax: 157,
      currency: 'JPY',
      transactionDate: '2026-07-10 12:03:00',
      items: [
        { name: '練りピーナッツ・ごま', quantity: 1, lineTotal: 292 },
        { name: '正宗生煎包', quantity: 3, unitPrice: 439, lineTotal: 1317 },
        { name: '豆腐皮', quantity: 1, lineTotal: 355 },
      ],
    }),
    recognition_snapshot_json: null,
    ...partial,
  };
}

describe('regression parseExport', () => {
  it('parses export envelope', () => {
    const env = loadExportEnvelope({
      exportedAt: '2026-08-30T00:00:00.000Z',
      receiptCount: 1,
      receipts: [makeRow({})],
    });
    expect(env.receipts).toHaveLength(1);
    expect(env.receiptCount).toBe(1);
  });

  it('parses nested JSON object', () => {
    const ok = parseNestedJsonObject('{"a":1}');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.a).toBe(1);
  });

  it('reports malformed nested JSON', () => {
    const bad = parseNestedJsonObject('{not-json');
    expect(bad.ok).toBe(false);
  });

  it('prefers recognition_snapshot over analysis', () => {
    const snap = {
      merchant: 'コストコ',
      total: 9534,
      tax: 708,
      items: [{ name: 'A', quantity: 1, lineTotal: 418 }],
    };
    const resolved = resolveBaselinePayload(
      makeRow({
        recognition_snapshot_json: JSON.stringify(snap),
        analysis_json: JSON.stringify({
          merchant: 'コストコ',
          total: 9534,
          tax: 706,
          items: [],
        }),
      })
    );
    expect(resolved.baselineStage).toBe('recognition_snapshot');
    expect(resolved.baselinePayload?.tax).toBe(708);
    expect(resolved.fallbackReason).toBeNull();
  });

  it('falls back to analysis when snapshot missing', () => {
    const resolved = resolveBaselinePayload(makeRow({}));
    expect(resolved.baselineStage).toBe('analysis_current');
    expect(resolved.fallbackReason).toBe('missing_recognition_snapshot');
  });

  it('reports malformed snapshot and falls back with reason', () => {
    const resolved = resolveBaselinePayload(
      makeRow({
        recognition_snapshot_json: '{broken',
      })
    );
    expect(resolved.baselineStage).toBe('analysis_current');
    expect(resolved.parseError).toContain('recognition_snapshot_json');
    expect(resolved.fallbackReason).toContain('malformed_recognition_snapshot');
    expect(resolved.baselinePayload?.tax).toBe(157);
  });

  it('does not crash whole load on one bad row', () => {
    const row = loadHistoricalRow(
      makeRow({ recognition_snapshot_json: '{broken', analysis_json: 'also-bad' })
    );
    expect(row.baselineStage).toBe('unavailable');
    expect(row.parseError).toBeTruthy();
  });
});

describe('regression projection + checks', () => {
  it('projects quantityTotal and reconciliation', () => {
    const payload = JSON.parse(String(makeRow({}).analysis_json));
    const proj = projectCanonicalFromPayload(payload);
    expect(proj.itemRowCount).toBe(3);
    expect(proj.quantityTotal).toBe(5);
    expect(proj.total).toBe(2121);
    expect(proj.reconciliation.itemsPositiveSum).toBe(1964);
  });

  it('runs deterministic checks without network', () => {
    const payload = JSON.parse(String(makeRow({}).analysis_json));
    const out = runDeterministicChecks(payload, { receiptId: 't1' });
    expect(out.indexRowCount).toBe(3);
    expect(out.identityProjected).toBe(true);
    expect(out.normalizeReplayExperimental).toBeNull();
  });
});

describe('regression matching', () => {
  const rows: LoadedHistoricalRow[] = [
    loadHistoricalRow(makeRow({ id: 'a', created_at: 1_700_000_000_000 })),
    loadHistoricalRow(
      makeRow({
        id: 'b',
        created_at: 1_800_000_000_000,
        recognition_snapshot_json: JSON.stringify({
          merchant: '業務スーパー古川店',
          total: 2121,
          tax: 157,
          items: [{ name: '豆腐皮', quantity: 1, lineTotal: 355 }],
        }),
      })
    ),
  ];

  it('matches selector single / multiple', () => {
    const manifest: RegressionManifest = {
      schemaVersion: 1,
      receiptNo: 81,
      selectors: {
        merchant: '業務スーパー古川店',
        total: 2121,
        transactionAt: '2026-07-10T12:03:00+09:00',
      },
      truth: { total: 2121 },
    };
    const hits = matchManifestToRows(manifest, rows);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.map((h) => h.receiptId).sort()).toEqual(['a', 'b']);
  });

  it('picks representative preferring snapshot then newest created_at', () => {
    const hits = matchManifestToRows(
      {
        schemaVersion: 1,
        receiptNo: 81,
        selectors: { total: 2121, merchant: '業務スーパー' },
        truth: {},
      },
      rows
    );
    const rep = pickRepresentativeRow(hits);
    expect(rep?.row.receiptId).toBe('b');
    expect(rep?.rule).toBe(
      'prefer_recognition_snapshot>newest_created_at>stable_id'
    );
  });

  it('sourceReceiptIds do NOT drive matching', () => {
    const hits = matchManifestToRows(
      {
        schemaVersion: 1,
        receiptNo: 81,
        sourceReceiptIds: ['a'],
        selectors: {
          merchant: '業務スーパー古川店',
          total: 2121,
          transactionAt: '2026-07-10T12:03:00+09:00',
        },
        truth: {},
      },
      rows
    );
    // Both selector matches; ids metadata ignored for matching.
    expect(hits.map((h) => h.receiptId).sort()).toEqual(['a', 'b']);
  });
});

describe('regression merchant compare', () => {
  it('exact / compatible / mismatch', () => {
    expect(merchantCompatible('ヨークベニマル', 'ヨークベニマル 古川南店')).toBe(
      true
    );
    expect(merchantCompatible('業務スーパー', '業務スーパー古川店')).toBe(true);
    expect(merchantCompatible('イオン', 'コストコ')).toBe(false);

    const exact = compareMerchants({
      truthMerchant: 'ヨークベニマル 古川南店',
      baselineMerchant: 'ヨークベニマル 古川南店',
      currentMerchant: 'ヨークベニマル 古川南店',
    });
    expect(exact.merchantExact).toBe(true);
    expect(exact.merchantRetailerCompatible).toBe(true);

    const compat = compareMerchants({
      truthMerchant: 'ヨークベニマル 古川南店',
      baselineMerchant: 'ヨークベニマル',
      currentMerchant: 'ヨークベニマル',
    });
    expect(compat.merchantExact).toBe(false);
    expect(compat.merchantRetailerCompatible).toBe(true);
  });
});

describe('regression grading', () => {
  it('STABLE_INCORRECT when both wrong and unchanged', () => {
    expect(
      gradeScalarField({
        field: 'tax',
        truth: 708,
        baseline: 706,
        current: 706,
        hasTruth: true,
      }).verdict
    ).toBe('STABLE_INCORRECT');
  });

  it('IMPROVEMENT / REGRESSION / CORRECT_STABLE / CHANGED_STILL_INCORRECT', () => {
    expect(
      gradeScalarField({
        field: 'tax',
        truth: 708,
        baseline: 706,
        current: 708,
        hasTruth: true,
      }).verdict
    ).toBe('IMPROVEMENT');

    expect(
      gradeScalarField({
        field: 'tax',
        truth: 708,
        baseline: 708,
        current: 706,
        hasTruth: true,
      }).verdict
    ).toBe('REGRESSION');

    expect(
      gradeScalarField({
        field: 'tax',
        truth: 708,
        baseline: 708,
        current: 708,
        hasTruth: true,
      }).verdict
    ).toBe('CORRECT_STABLE');

    expect(
      gradeScalarField({
        field: 'tax',
        truth: 708,
        baseline: 700,
        current: 701,
        hasTruth: true,
      }).verdict
    ).toBe('CHANGED_STILL_INCORRECT');
  });

  it('no-truth CHANGED_UNKNOWN / UNCHANGED', () => {
    expect(
      gradeScalarField({
        field: 'tax',
        truth: undefined,
        baseline: 706,
        current: 708,
        hasTruth: false,
      }).verdict
    ).toBe('CHANGED_UNKNOWN');
    expect(
      gradeScalarField({
        field: 'tax',
        truth: undefined,
        baseline: 708,
        current: 708,
        hasTruth: false,
      }).verdict
    ).toBe('UNCHANGED');
  });

  it('partial truth does not invent missing items as wrong', () => {
    const baseline = projectCanonicalFromPayload({
      merchant: 'ヨークベニマル 古川南店',
      total: 3606,
      tax: 267,
      items: [
        { name: 'ラム肩', quantity: 3, unitPrice: 310, lineTotal: 930 },
        { name: 'カイノミステーキ用', quantity: 1, lineTotal: 400 },
        { name: 'カイノミステーキ用', quantity: 1, lineTotal: 440 },
        { name: 'カイノミステーキ用', quantity: 1, lineTotal: 460 },
        { name: 'UNKNOWN_A', quantity: 1, lineTotal: 100 },
        { name: 'UNKNOWN_B', quantity: 1, lineTotal: 100 },
        { name: 'UNKNOWN_C', quantity: 1, lineTotal: 100 },
        { name: 'UNKNOWN_D', quantity: 1, lineTotal: 100 },
        { name: 'UNKNOWN_E', quantity: 1, lineTotal: 100 },
        { name: 'UNKNOWN_F', quantity: 1, lineTotal: 676 },
      ],
    });
    const graded = gradeAgainstTruth({
      truth: {
        total: 3606,
        itemRowCount: 10,
        quantityTotal: 12,
        completeBasket: false,
        confirmedMerchandise: [
          { nameContains: 'ラム肩', quantity: 3, unitPrice: 310, lineTotal: 930 },
          { nameContains: 'カイノミステーキ用', lineTotal: 400 },
          { nameContains: 'カイノミステーキ用', lineTotal: 440 },
          { nameContains: 'カイノミステーキ用', lineTotal: 460 },
        ],
      },
      baseline,
      current: baseline,
    });
    expect(graded.completeBasket).toBe(false);
    const wrongUnknown = graded.comparisons.filter(
      (c) => c.field.includes('UNKNOWN') && c.verdict === 'REGRESSION'
    );
    expect(wrongUnknown).toHaveLength(0);
  });

  it('complete truth grades item presence', () => {
    const payload = JSON.parse(String(makeRow({}).analysis_json));
    const proj = projectCanonicalFromPayload(payload);
    const graded = gradeAgainstTruth({
      truth: {
        total: 2121,
        tax: 157,
        itemRowCount: 3,
        quantityTotal: 5,
        completeBasket: true,
        items: [
          { name: '練りピーナッツ・ごま', quantity: 1, lineTotal: 292 },
          { name: '正宗生煎包', quantity: 3, unitPrice: 439, lineTotal: 1317 },
          { name: '豆腐皮', quantity: 1, lineTotal: 355 },
        ],
      },
      baseline: proj,
      current: proj,
    });
    expect(graded.completeBasket).toBe(true);
    expect(
      graded.comparisons.some(
        (c) => c.field === 'quantityTotal' && c.verdict === 'CORRECT_STABLE'
      )
    ).toBe(true);
  });
});

describe('regression privacy + exit', () => {
  it('redacts sensitive keys and local image paths', () => {
    const redacted = redactForReport({
      user_id: 'u1',
      installation_id: 'i1',
      access_token: 'tok',
      receiptId: 'ok',
      image_uri: 'file:///var/mobile/Containers/Data/Application/x/Library/Caches/ImagePicker/a.heic',
    });
    expect(containsSensitiveKeys(redacted)).toBe(false);
    expect((redacted as any).receiptId).toBe('ok');
    expect((redacted as any).image_uri).toBe('[redacted_local_path]');
  });

  it('--fail-on-regression exit decision', () => {
    const baseSummary = {
      rowsLoaded: 0,
      snapshotUsable: 0,
      analysisFallback: 0,
      unavailable: 0,
      malformedRows: 0,
      physicalManifests: 0,
      matchedManifests: 0,
      unmatchedManifests: 0,
      correctStable: 0,
      improvements: 0,
      regressions: 0,
      changedStillIncorrect: 0,
      stableIncorrect: 0,
      unknown: 0,
      unchangedNoTruth: 0,
      changedUnknown: 0,
      truthCorrectStable: 0,
      truthImprovements: 0,
      truthRegressions: 0,
      truthStableIncorrect: 0,
      truthChangedStillIncorrect: 0,
      truthUnknown: 0,
    };
    const withRegression = {
      metadata: {
        generatedAt: '',
        exportPathBasename: 'x.json',
        exportReceiptRowCount: 0,
        harnessVersion: 't',
        gitHead: null,
        failOnRegression: true,
      },
      summary: { ...baseSummary, truthRegressions: 1, regressions: 1 },
      deepConsumers: { repeat: 'not_run_phase1' as const, pph: 'not_run_phase1' as const },
      rows: [],
      manifests: [
        {
          receiptNo: 80,
          matchedHistoricalRows: ['x'],
          duplicateHistoricalRows: false,
          representativeReceiptId: 'x',
          representativeRule: 'single_match',
          unmatched: false,
          fieldComparisons: [
            {
              field: 'tax',
              verdict: 'REGRESSION' as const,
              truth: 708,
              baseline: 708,
              current: 706,
            },
          ],
          merchantCompare: null,
          completeBasket: false,
        },
      ],
    };

    const withStableIncorrect = {
      ...withRegression,
      summary: { ...baseSummary, truthStableIncorrect: 1, stableIncorrect: 1 },
      manifests: [
        {
          ...withRegression.manifests[0],
          fieldComparisons: [
            {
              field: 'tax',
              verdict: 'STABLE_INCORRECT' as const,
              truth: 708,
              baseline: 706,
              current: 706,
            },
          ],
        },
      ],
    };

    expect(
      resolveExitCode({
        failOnRegression: false,
        harnessFailed: false,
        report: withRegression,
      })
    ).toBe(0);

    expect(
      resolveExitCode({
        failOnRegression: true,
        harnessFailed: false,
        report: withRegression,
      })
    ).toBe(1);

    expect(
      resolveExitCode({
        failOnRegression: true,
        harnessFailed: false,
        report: withStableIncorrect,
      })
    ).toBe(0);

    expect(collectTruthRegressions(withRegression)).toHaveLength(1);

    expect(
      resolveExitCode({
        failOnRegression: true,
        harnessFailed: true,
        report: null,
      })
    ).toBe(1);
  });
});

describe('regression date + representative (truth-independent)', () => {
  const FP = [418, 698, 428, 899, 488, 298, 998, 698, 777, 3484, 348];

  function costcoRow(partial: {
    id: string;
    year: number;
    created_at: number;
    total?: number;
    merchant?: string;
    amounts?: number[];
  }): LoadedHistoricalRow {
    const y = partial.year;
    const amounts = partial.amounts ?? FP;
    return loadHistoricalRow(
      makeRow({
        id: partial.id,
        created_at: partial.created_at,
        merchant_raw: partial.merchant ?? 'コストコ',
        total: partial.total ?? 9534,
        tax: 706,
        transaction_at: Date.parse(`${y}-07-06T11:44:46+09:00`),
        recognition_snapshot_json: JSON.stringify({
          merchant: partial.merchant ?? 'コストコ',
          total: partial.total ?? 9534,
          tax: 706,
          transactionDate: `07/06/${y} 11:44:46`,
          items: amounts.map((lineTotal, i) => ({
            name: `I${i}`,
            quantity: 1,
            lineTotal,
          })),
        }),
      })
    );
  }

  it('treats ISO and JP formatted same local minute as equal', () => {
    expect(
      receiptTimestampsEqual(
        '2026-06-18T17:44:00+09:00',
        '2026/6/18(木) 17:44',
        'イオン古川店'
      )
    ).toBe(true);
    expect(
      gradeScalarField({
        field: 'transactionAt',
        truth: '2026-06-18T17:44:00+09:00',
        baseline: '2026/6/18(木) 17:44',
        current: '2026/6/18(木) 17:44',
        hasTruth: true,
        merchantHint: 'イオン古川店',
      }).verdict
    ).toBe('CORRECT_STABLE');
  });

  it('representative selection is invariant to human truth year', () => {
    const rows = [
      costcoRow({ id: 'rowA-2023-newer', year: 2023, created_at: 2_000 }),
      costcoRow({ id: 'rowB-2026-older', year: 2026, created_at: 1_000 }),
    ];
    const hits = matchManifestToRows(
      {
        schemaVersion: 1,
        receiptNo: 80,
        selectors: {
          merchant: 'コストコ',
          total: 9534,
          transactionAt: '2026-07-06T11:44:46+09:00',
          transactionAtMatch: 'local_clock_ignore_year',
          orderedLineAmountsFingerprint: FP,
        },
        truth: { transactionAt: '2026-07-06T11:44:46+09:00' },
      },
      rows
    );
    expect(hits).toHaveLength(2);
    const rep2026Truth = pickRepresentativeRow(hits);
    // Newer created_at wins (rowA 2023), NOT truth year 2026.
    expect(rep2026Truth?.row.receiptId).toBe('rowA-2023-newer');
    expect(rep2026Truth?.rule).not.toContain('truth');

    // Change truth year — representative must stay the same.
    const hits2 = matchManifestToRows(
      {
        schemaVersion: 1,
        receiptNo: 80,
        selectors: {
          merchant: 'コストコ',
          total: 9534,
          transactionAt: '2024-07-06T11:44:46+09:00',
          transactionAtMatch: 'local_clock_ignore_year',
          orderedLineAmountsFingerprint: FP,
        },
        truth: { transactionAt: '2024-07-06T11:44:46+09:00' },
      },
      rows
    );
    const rep2024Truth = pickRepresentativeRow(hits2);
    expect(rep2024Truth?.row.receiptId).toBe(rep2026Truth?.row.receiptId);
  });

  it('default exact match does NOT ignore year', () => {
    const rows = [
      costcoRow({ id: 'y2023', year: 2023, created_at: 1 }),
      costcoRow({ id: 'y2026', year: 2026, created_at: 2 }),
    ];
    const hits = matchManifestToRows(
      {
        schemaVersion: 1,
        receiptNo: 80,
        selectors: {
          merchant: 'コストコ',
          total: 9534,
          transactionAt: '2026-07-06T11:44:46+09:00',
          transactionAtMatch: 'exact',
        },
        truth: {},
      },
      rows
    );
    expect(hits.map((h) => h.receiptId)).toEqual(['y2026']);
  });

  it('explicit ignore-year requires merchant and total anchors', () => {
    const rows = [
      costcoRow({ id: 'ok', year: 2023, created_at: 1 }),
      costcoRow({
        id: 'wrong-total',
        year: 2023,
        created_at: 2,
        total: 9999,
        amounts: [9999],
      }),
      costcoRow({
        id: 'wrong-merchant',
        year: 2023,
        created_at: 3,
        merchant: 'イオン',
      }),
    ];
    const base = {
      schemaVersion: 1 as const,
      receiptNo: 80,
      truth: {},
    };
    const hits = matchManifestToRows(
      {
        ...base,
        selectors: {
          merchant: 'コストコ',
          total: 9534,
          transactionAt: '2026-07-06T11:44:46+09:00',
          transactionAtMatch: 'local_clock_ignore_year',
          orderedLineAmountsFingerprint: FP,
        },
      },
      rows
    );
    expect(hits.map((h) => h.receiptId)).toEqual(['ok']);

    // Missing merchant in selector → ignore-year gate rejects all
    expect(
      matchManifestToRows(
        {
          ...base,
          selectors: {
            total: 9534,
            transactionAt: '2026-07-06T11:44:46+09:00',
            transactionAtMatch: 'local_clock_ignore_year',
          },
        },
        rows
      )
    ).toHaveLength(0);
  });

  it('deterministic representative across repeated runs', () => {
    const rows = [
      costcoRow({ id: 'y2023', year: 2023, created_at: 100 }),
      costcoRow({ id: 'y2026', year: 2026, created_at: 50 }),
    ];
    const hits = matchManifestToRows(
      {
        schemaVersion: 1,
        receiptNo: 80,
        selectors: {
          merchant: 'コストコ',
          total: 9534,
          transactionAt: '2026-07-06T11:44:46+09:00',
          transactionAtMatch: 'local_clock_ignore_year',
        },
        truth: {},
      },
      rows
    );
    const a = pickRepresentativeRow(hits);
    const b = pickRepresentativeRow(hits);
    expect(a?.row.receiptId).toBe(b?.row.receiptId);
    expect(a?.row.receiptId).toBe('y2023'); // newer created_at
  });

  it('same transaction + phantom extra rows still matches; fingerprint reports extra', () => {
    const clean = costcoRow({ id: 'clean', year: 2023, created_at: 1 });
    const phantom708 = loadHistoricalRow(
      makeRow({
        id: 'phantom',
        created_at: 2,
        merchant_raw: 'コストコ',
        total: 9534,
        tax: 708,
        transaction_at: Date.parse('2023-07-06T11:44:46+09:00'),
        recognition_snapshot_json: JSON.stringify({
          merchant: 'コストコ',
          total: 9534,
          tax: 708,
          transactionDate: '07/06/2023 11:44:46',
          items: [
            ...FP.map((lineTotal, i) => ({
              name: `I${i}`,
              quantity: 1,
              lineTotal,
            })),
            {
              name: '1-Z コストコ コネクション ムリョウ',
              quantity: 1,
              lineTotal: 1,
            },
            { name: 'extra', quantity: 1, lineTotal: 1 },
          ],
        }),
      })
    );

    const hits = matchManifestToRows(
      {
        schemaVersion: 1,
        receiptNo: 80,
        selectors: {
          merchant: 'コストコ',
          total: 9534,
          transactionAt: '2026-07-06T11:44:46+09:00',
          transactionAtMatch: 'local_clock_ignore_year',
          // Fingerprint present but must NOT exclude phantom member.
          orderedLineAmountsFingerprint: FP,
        },
        truth: { tax: 708, itemRowCount: 11 },
      },
      [clean, phantom708]
    );
    expect(hits.map((h) => h.receiptId).sort()).toEqual(['clean', 'phantom']);

    expect(classifyLineAmountsFingerprint(FP, FP)).toBe('exact');
    expect(
      classifyLineAmountsFingerprint(FP, [...FP, 1, 1])
    ).toBe('contains_expected_lines_plus_extra');

    // tax / itemRowCount differences do not affect membership
    expect(hits.find((h) => h.receiptId === 'phantom')?.tax).toBe(708);
    expect(
      Array.isArray(hits.find((h) => h.receiptId === 'phantom')?.baselinePayload?.items) &&
        (hits.find((h) => h.receiptId === 'phantom')!.baselinePayload!.items as unknown[])
          .length
    ).toBe(13);
  });
});

describe('regression end-to-end harness on temp export', () => {
  it('runs offline and writes graded report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meruno-reg-'));
    const exportPath = path.join(dir, 'receipts_export_test.json');
    const manifestDir = path.join(dir, 'manifests');
    fs.mkdirSync(manifestDir);
    fs.writeFileSync(
      exportPath,
      JSON.stringify({
        exportedAt: new Date().toISOString(),
        receiptCount: 2,
        receipts: [
          makeRow({
            id: 'hist-1',
            recognition_snapshot_json: JSON.stringify({
              merchant: '業務スーパー古川店',
              total: 2121,
              tax: 157,
              currency: 'JPY',
              transactionDate: '2026-07-10 12:03:00',
              items: [
                { name: '練りピーナッツ・ごま', quantity: 1, lineTotal: 292 },
                { name: '正宗生煎包', quantity: 3, unitPrice: 439, lineTotal: 1317 },
                { name: '豆腐皮', quantity: 1, lineTotal: 355 },
              ],
            }),
          }),
          makeRow({
            id: 'hist-2',
            total: 9534,
            tax: 706,
            merchant_raw: 'コストコ',
            transaction_at: Date.parse('2026-07-06T11:44:46+09:00'),
            analysis_json: JSON.stringify({
              merchant: 'コストコ',
              total: 9534,
              tax: 706,
              items: [418, 698, 428, 899, 488, 298, 998, 698, 777, 3484, 348].map(
                (lineTotal, i) => ({
                  name: `ITEM${i}`,
                  quantity: 1,
                  lineTotal,
                })
              ),
            }),
            recognition_snapshot_json: null,
          }),
        ],
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(manifestDir, 'receipt081.json'),
      JSON.stringify({
        schemaVersion: 1,
        receiptNo: 81,
        selectors: {
          merchant: '業務スーパー古川店',
          total: 2121,
          transactionAt: '2026-07-10T12:03:00+09:00',
        },
        truth: {
          merchant: '業務スーパー古川店',
          total: 2121,
          tax: 157,
          itemRowCount: 3,
          quantityTotal: 5,
          completeBasket: true,
        },
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(manifestDir, 'receipt080.json'),
      JSON.stringify({
        schemaVersion: 1,
        receiptNo: 80,
        selectors: {
          merchant: 'コストコ',
          total: 9534,
          transactionAt: '2026-07-06T11:44:46+09:00',
        },
        truth: {
          tax: 708,
          total: 9534,
          orderedLineAmounts: [
            418, 698, 428, 899, 488, 298, 998, 698, 777, 3484, 348,
          ],
        },
      }),
      'utf8'
    );

    const report = runRegressionHarness({
      exportPath,
      manifestDir,
      gitHead: 'test',
    });

    expect(report.summary.rowsLoaded).toBe(2);
    expect(report.summary.snapshotUsable).toBe(1);
    expect(report.summary.analysisFallback).toBe(1);
    expect(report.summary.matchedManifests).toBe(2);
    expect(report.deepConsumers.repeat).toBe('not_run_phase1');
    expect(containsSensitiveKeys(report)).toBe(false);

    const r80 = report.manifests.find((m) => m.receiptNo === 80);
    expect(r80).toBeTruthy();
    // Phase 1 does not rewrite stored tax — both baseline+current remain 706 vs truth 708.
    const taxCmp = r80!.fieldComparisons.find((c) => c.field === 'tax');
    expect(taxCmp?.verdict).toBe('STABLE_INCORRECT');
    expect(taxCmp?.baseline).toBe(706);
    expect(taxCmp?.current).toBe(706);
    expect(taxCmp?.truth).toBe(708);
    expect(report.summary.truthStableIncorrect).toBeGreaterThanOrEqual(1);

    const summary = formatConsoleSummary(report);
    expect(summary).toContain('Meruno Receipt Regression');
    expect(summary).not.toContain('secret-user');
    expect(summary.length).toBeLessThan(5000);

    // no-truth delta helper smoke
    const deltas = gradeNoTruthDelta(
      report.rows[0].observed!,
      report.rows[0].current!.projection
    );
    expect(deltas.length).toBeGreaterThan(0);
  });
});
