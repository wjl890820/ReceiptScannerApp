/**
 * A1.4B-1 — Evidence-aware representative promotion (strict override only).
 * Membership immutable; no shadow tri-state promotion.
 */

/* eslint-disable import/first */
jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn() }));
jest.mock('../db', () => ({
  initIfNeeded: jest.fn(async () => undefined),
  listReceipts: jest.fn(async () => []),
}));

import * as fs from 'fs';
import * as path from 'path';

import type { ReceiptRow } from '../db';
import {
  buildHighConfidenceDuplicateGroups,
  summarizeReceiptForDuplicateAudit,
} from '../analysisDDuplicateAudit';
import { selectAnalyticsReceipts } from '../analyticsReceiptSelection';
import { receiptRowFromIntelligenceExport } from '../productIdentityShadowAuditDataset';
import {
  buildCanonicalReceiptGroups,
  applyEvidenceAwareRepresentativeOverride,
  isTrustedMonetaryRepresentative,
} from './canonicalReceipt';
import { buildReceiptMonetaryCoherenceEvidence } from '../receiptEvidenceTruth/monetaryCoherenceEvidence';
import {
  buildGroundTruthShadowAudit,
  buildProductionShadowCandidateNodes,
  GROUND_TRUTH_CASE_RECEIPT_IDS,
} from '../receiptEvidenceTruth';
import { pickBestRepresentativeReceiptId } from '../receiptRepresentativeQuality';

function makeReceipt(args: {
  id: string;
  merchantRaw?: string;
  merchantNormalized?: string;
  transactionAt?: number | null;
  total?: number;
  tax?: number;
  taxIsKnown?: number;
  createdAt?: number;
  userEdited?: number;
  analysis?: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
}): ReceiptRow {
  const items = args.items ?? [
    { name: 'A', quantity: 1, lineTotal: args.total ?? 100 },
  ];
  const analysis = {
    items,
    ...args.analysis,
  };
  return {
    id: args.id,
    created_at: args.createdAt ?? 1,
    transaction_at:
      args.transactionAt === undefined
        ? Date.parse('2026-01-06T07:23:00Z')
        : args.transactionAt,
    image_uri: '',
    merchant_raw: args.merchantRaw ?? 'テスト',
    merchant_normalized:
      args.merchantNormalized ?? args.merchantRaw ?? 'テスト',
    merchant_type: 'supermarket',
    store_raw: null,
    store_normalized: null,
    total: args.total ?? 100,
    tax: args.tax ?? 8,
    tax_is_known: args.taxIsKnown ?? 1,
    currency: 'JPY',
    analysis_json: JSON.stringify(analysis),
    user_edited: args.userEdited ?? 0,
    final_total: null,
    final_category: null,
    note: null,
    user_items_json: null,
  };
}

function trustedCoherent(id: string, opts?: { createdAt?: number; userEdited?: number }) {
  return makeReceipt({
    id,
    total: 8351,
    createdAt: opts?.createdAt ?? 1,
    userEdited: opts?.userEdited ?? 0,
    taxIsKnown: 0,
    items: [{ name: 'Item', quantity: 1, lineTotal: 8351 }],
    analysis: {
      reconciliation: { ok: true },
      amount_mismatch: false,
    },
  });
}

function knownIncoherent(id: string, opts?: { createdAt?: number; userEdited?: number }) {
  return makeReceipt({
    id,
    total: 8351,
    createdAt: opts?.createdAt ?? 1,
    userEdited: opts?.userEdited ?? 0,
    taxIsKnown: 0,
    items: [{ name: 'Item', quantity: 1, lineTotal: 9000 }],
    analysis: {
      reconciliation: { ok: false },
      amount_mismatch: true,
    },
  });
}

function unknownMonetary(id: string) {
  return makeReceipt({
    id,
    total: 8351,
    taxIsKnown: 0,
    items: [{ name: 'Item', quantity: 1, lineTotal: null as unknown as number }],
    analysis: {},
  });
}

function unresolvedDiscount(id: string) {
  return makeReceipt({
    id,
    merchantRaw: 'ヨークベニマル',
    total: 2733,
    taxIsKnown: 0,
    items: [
      { name: 'プレーンビス', quantity: 3, lineTotal: 324 },
      { name: 'チョコ', quantity: 1, lineTotal: 2409 },
    ],
    analysis: {
      discounts: [{ label: 'まとめ売り値引', amount: -33 }],
      reconciliation: { ok: true },
      amount_mismatch: false,
    },
  });
}

describe('A1.4B-1 evidence-aware representative override', () => {
  test('1. baseline trusted => no churn even if peer also trusted with higher quality', () => {
    const baseline = trustedCoherent('trusted-baseline', {
      createdAt: 1,
      userEdited: 0,
    });
    const richer = trustedCoherent('trusted-richer', {
      createdAt: 2,
      userEdited: 1,
    });
    expect(isTrustedMonetaryRepresentative(baseline)).toBe(true);
    expect(isTrustedMonetaryRepresentative(richer)).toBe(true);

    const receiptById = new Map([
      [baseline.id, baseline],
      [richer.id, richer],
    ]);
    const summaries = [baseline, richer].map(summarizeReceiptForDuplicateAudit);
    const qualityWinner = pickBestRepresentativeReceiptId(summaries, receiptById);
    expect(qualityWinner).toBe(richer.id);

    const result = applyEvidenceAwareRepresentativeOverride({
      baselineRepresentativeId: baseline.id,
      sourceReceiptIds: [baseline.id, richer.id],
      receiptById,
      memberSummaries: summaries,
    });
    expect(result.changed).toBe(false);
    expect(result.representativeId).toBe(baseline.id);
    expect(result.reason).toBe('baseline_already_trusted');
  });

  test('2. baseline untrusted + one trusted alternative => trusted selected', () => {
    const bad = knownIncoherent('bad-baseline', { userEdited: 1 });
    const good = trustedCoherent('good-alt');
    expect(isTrustedMonetaryRepresentative(bad)).toBe(false);
    expect(isTrustedMonetaryRepresentative(good)).toBe(true);

    const receiptById = new Map([
      [bad.id, bad],
      [good.id, good],
    ]);
    const result = applyEvidenceAwareRepresentativeOverride({
      baselineRepresentativeId: bad.id,
      sourceReceiptIds: [bad.id, good.id],
      receiptById,
      memberSummaries: [bad, good].map(summarizeReceiptForDuplicateAudit),
    });
    expect(result.changed).toBe(true);
    expect(result.representativeId).toBe(good.id);
    expect(result.reason).toBe('trusted_monetary_override');
  });

  test('3. baseline untrusted + no trusted alternative => baseline retained', () => {
    const bad = knownIncoherent('bad-keep');
    const unk = unknownMonetary('unknown-peer');
    expect(buildReceiptMonetaryCoherenceEvidence(bad).state).toBe(
      'known_incoherent'
    );
    expect(buildReceiptMonetaryCoherenceEvidence(unk).state).toBe('unknown');

    const result = applyEvidenceAwareRepresentativeOverride({
      baselineRepresentativeId: bad.id,
      sourceReceiptIds: [bad.id, unk.id],
      receiptById: new Map([
        [bad.id, bad],
        [unk.id, unk],
      ]),
      memberSummaries: [bad, unk].map(summarizeReceiptForDuplicateAudit),
    });
    expect(result.changed).toBe(false);
    expect(result.representativeId).toBe(bad.id);
    expect(result.reason).toBe('no_trusted_alternative');
  });

  test('4. multiple trusted alternatives => existing quality picker; order-deterministic', () => {
    const bad = knownIncoherent('bad-multi');
    const t1 = trustedCoherent('trusted-a', { createdAt: 10, userEdited: 0 });
    const t2 = trustedCoherent('trusted-b', { createdAt: 20, userEdited: 1 });
    const receiptById = new Map([
      [bad.id, bad],
      [t1.id, t1],
      [t2.id, t2],
    ]);
    const summariesFwd = [bad, t1, t2].map(summarizeReceiptForDuplicateAudit);
    const summariesRev = [t2, t1, bad].map(summarizeReceiptForDuplicateAudit);

    const fwd = applyEvidenceAwareRepresentativeOverride({
      baselineRepresentativeId: bad.id,
      sourceReceiptIds: [bad.id, t1.id, t2.id],
      receiptById,
      memberSummaries: summariesFwd,
    });
    const rev = applyEvidenceAwareRepresentativeOverride({
      baselineRepresentativeId: bad.id,
      sourceReceiptIds: [t2.id, t1.id, bad.id],
      receiptById,
      memberSummaries: summariesRev,
    });
    expect(fwd.representativeId).toBe(t2.id);
    expect(rev.representativeId).toBe(t2.id);
    expect(fwd.representativeId).toBe(rev.representativeId);
  });

  test('5. representative always belongs to sourceReceiptIds', () => {
    const bad = knownIncoherent('bad-member');
    const good = trustedCoherent('good-member');
    const result = applyEvidenceAwareRepresentativeOverride({
      baselineRepresentativeId: bad.id,
      sourceReceiptIds: [bad.id, good.id],
      receiptById: new Map([
        [bad.id, bad],
        [good.id, good],
      ]),
      memberSummaries: [bad, good].map(summarizeReceiptForDuplicateAudit),
    });
    expect([bad.id, good.id]).toContain(result.representativeId);
  });

  test('6. group membership deep-equal before/after override path', () => {
    const at = Date.parse('2024-06-01T14:22:33+09:00');
    const items = [
      { name: '牛乳', lineTotal: 198, quantity: 1 },
      { name: 'パン', lineTotal: 128, quantity: 1 },
    ];
    const r1 = makeReceipt({
      id: 'mem-a',
      merchantNormalized: 'イオン',
      transactionAt: at,
      total: 326,
      createdAt: at - 60_000,
      items,
      analysis: { reconciliation: { ok: true }, amount_mismatch: false },
    });
    const r2 = makeReceipt({
      id: 'mem-b',
      merchantNormalized: 'イオン',
      transactionAt: at,
      total: 326,
      createdAt: at,
      items,
      analysis: { reconciliation: { ok: true }, amount_mismatch: false },
    });

    const dGroups = buildHighConfidenceDuplicateGroups(
      [r1, r2].map(summarizeReceiptForDuplicateAudit),
      [r1, r2]
    );
    expect(dGroups).toHaveLength(1);
    const beforeMembership = [...dGroups[0]!.receiptIds].sort();

    const canonical = buildCanonicalReceiptGroups([r1, r2]);
    expect(canonical).toHaveLength(1);
    expect([...canonical[0]!.sourceReceiptIds].sort()).toEqual(beforeMembership);
    expect(canonical[0]!.confidence).toBe(dGroups[0]!.confidence);
    expect(canonical[0]!.duplicateCount).toBe(
      Math.max(0, beforeMembership.length - 1)
    );
  });

  test('7. unresolved discount ownership cannot override', () => {
    const unresolved = unresolvedDiscount('unresolved-alt');
    const incoherent = makeReceipt({
      id: 'bad-vs-unresolved',
      total: 2733,
      taxIsKnown: 0,
      items: [{ name: 'X', quantity: 1, lineTotal: 3000 }],
      analysis: { reconciliation: { ok: false }, amount_mismatch: true },
    });
    const mon = buildReceiptMonetaryCoherenceEvidence(unresolved);
    expect(mon.discountOwnershipStatus).toBe('unresolved');
    expect(mon.monetaryProvenanceSufficient).toBe(false);
    expect(isTrustedMonetaryRepresentative(unresolved)).toBe(false);

    const result = applyEvidenceAwareRepresentativeOverride({
      baselineRepresentativeId: incoherent.id,
      sourceReceiptIds: [incoherent.id, unresolved.id],
      receiptById: new Map([
        [incoherent.id, incoherent],
        [unresolved.id, unresolved],
      ]),
      memberSummaries: [incoherent, unresolved].map(
        summarizeReceiptForDuplicateAudit
      ),
    });
    expect(result.changed).toBe(false);
    expect(result.representativeId).toBe(incoherent.id);
    expect(result.reason).toBe('no_trusted_alternative');
  });

  test('8. monetaryProvenanceSufficient=false cannot override', () => {
    const insufficient = unresolvedDiscount('insuff-prov');
    expect(
      buildReceiptMonetaryCoherenceEvidence(insufficient)
        .monetaryProvenanceSufficient
    ).toBe(false);
    const baseline = knownIncoherent('base-insuff');
    const result = applyEvidenceAwareRepresentativeOverride({
      baselineRepresentativeId: baseline.id,
      sourceReceiptIds: [baseline.id, insufficient.id],
      receiptById: new Map([
        [baseline.id, baseline],
        [insufficient.id, insufficient],
      ]),
      memberSummaries: [baseline, insufficient].map(
        summarizeReceiptForDuplicateAudit
      ),
    });
    expect(result.changed).toBe(false);
    expect(isTrustedMonetaryRepresentative(insufficient)).toBe(false);
  });
});

describe('A1.4B-1 live Ground Truth / production baseline', () => {
  const ARTIFACT = path.join(
    __dirname,
    '../../artifacts/product-intelligence-audit.json'
  );
  const hasArtifact = fs.existsSync(ARTIFACT);

  function loadReceipts(): ReceiptRow[] {
    const payload = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8')) as {
      receipts?: Array<Record<string, unknown>>;
    };
    return (payload.receipts ?? []).map(receiptRowFromIntelligenceExport);
  }

  (hasArtifact ? test : test.skip)(
    '9. GT-019 exact old -> new representative via general policy',
    () => {
      const receipts = loadReceipts();
      const ids = GROUND_TRUTH_CASE_RECEIPT_IDS['GT-019'];
      expect(ids).toContain('pbU0NavDejcsAEM7fGlMB');
      expect(ids).toContain('9Brk_HjDEvLeBD2i6c7Hb');

      const caseReceipts = receipts.filter((r) => ids.includes(r.id));
      expect(caseReceipts.length).toBe(ids.length);

      const dGroups = buildHighConfidenceDuplicateGroups(
        caseReceipts.map(summarizeReceiptForDuplicateAudit),
        caseReceipts
      );
      expect(dGroups.length).toBeGreaterThanOrEqual(1);
      const productionGroup = dGroups.find((g) =>
        ids.every((id) => g.receiptIds.includes(id))
      );
      // Baseline Analysis D representative for the GT-019 purchase cluster
      const baselineGroup =
        productionGroup ??
        dGroups.find((g) => g.receiptIds.includes('pbU0NavDejcsAEM7fGlMB'))!;
      expect(baselineGroup.representativeReceiptId).toBe(
        'pbU0NavDejcsAEM7fGlMB'
      );

      const pbU = caseReceipts.find((r) => r.id === 'pbU0NavDejcsAEM7fGlMB')!;
      const nineBr = caseReceipts.find((r) => r.id === '9Brk_HjDEvLeBD2i6c7Hb')!;
      expect(isTrustedMonetaryRepresentative(pbU)).toBe(false);
      expect(isTrustedMonetaryRepresentative(nineBr)).toBe(true);

      const groups = buildCanonicalReceiptGroups(caseReceipts);
      const canonical = groups.find((g) =>
        g.sourceReceiptIds.includes('pbU0NavDejcsAEM7fGlMB')
      )!;
      expect(canonical.representativeReceipt.id).toBe('9Brk_HjDEvLeBD2i6c7Hb');
      expect(canonical.sourceReceiptIds).toContain('pbU0NavDejcsAEM7fGlMB');
      expect(canonical.sourceReceiptIds).toContain('9Brk_HjDEvLeBD2i6c7Hb');
      expect(
        [...baselineGroup.receiptIds].sort()
      ).toEqual([...canonical.sourceReceiptIds].sort());

      const nodes = buildProductionShadowCandidateNodes(receipts);
      const gt019Node = nodes.find((n) =>
        n.sourceReceiptIds.includes('pbU0NavDejcsAEM7fGlMB')
      )!;
      expect(gt019Node.representativeReceiptId).toBe('9Brk_HjDEvLeBD2i6c7Hb');
    }
  );

  (hasArtifact ? test : test.skip)('10. GT-002 unchanged', () => {
    const receipts = loadReceipts();
    const report = buildGroundTruthShadowAudit(receipts);
    const gt002 = report.cases.find((c) => c.caseId === 'GT-002')!;
    expect(gt002.productionCandidateCount).toBe(3);
    expect(gt002.shadowDuplicateCandidateGroups).toHaveLength(0);
  });

  (hasArtifact ? test : test.skip)('11. GT-017 unchanged', () => {
    const receipts = loadReceipts();
    const report = buildGroundTruthShadowAudit(receipts);
    const gt017 = report.cases.find((c) => c.caseId === 'GT-017')!;
    expect(gt017.productionCandidateCount).toBe(2);
    if (
      gt017.merchantMetadataVariantEvaluation?.transactionAuthorization ===
      'insufficient_provenance'
    ) {
      expect(gt017.merchantMetadataVariantEvaluation.shadowDuplicateAuthorized).toBe(
        false
      );
    }
  });

  (hasArtifact ? test : test.skip)('12. GT-020 unchanged', () => {
    const receipts = loadReceipts();
    const report = buildGroundTruthShadowAudit(receipts);
    const gt020 = report.cases.find((c) => c.caseId === 'GT-020')!;
    expect(
      gt020.monetaryProvenanceNotes.some((n) =>
        n.includes('discountOwnership=unresolved')
      )
    ).toBe(true);
    expect(
      gt020.monetaryProvenanceNotes.some((n) =>
        n.includes('monetaryProvenanceSufficient=false')
      )
    ).toBe(true);
    const id = GROUND_TRUTH_CASE_RECEIPT_IDS['GT-020'][0]!;
    const receipt = receipts.find((r) => r.id === id)!;
    expect(isTrustedMonetaryRepresentative(receipt)).toBe(false);
  });

  (hasArtifact ? test : test.skip)('13. production 127 / 24 / 103 unchanged', () => {
    const receipts = loadReceipts();
    const selection = selectAnalyticsReceipts(receipts);
    expect(selection.storedReceipts).toHaveLength(127);
    expect(selection.highConfidenceDuplicateExtras).toBe(24);
    expect(selection.analyticsReceipts).toHaveLength(103);
  });
});
