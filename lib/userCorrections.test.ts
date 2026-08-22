import {
  USER_CORRECTIONS_CONTRACT_VERSION,
  amountCorrectionInput,
  appendUserCorrections,
  applyItemFieldCorrections,
  buildUserCorrectionEvent,
  categoryCorrectionInput,
  latestUserCorrection,
  nameCorrectionInput,
  quantityCorrectionInput,
  readUserCorrections,
  receiptFieldCorrectionInput,
  recordUserCorrection,
  resolveLegacyUserOverrideProvenance,
  stripUserCorrectionsForAnalyticsExport,
} from './userCorrections';
import {
  CLASSIFICATION_VERSION,
  TAXONOMY_VERSION,
  isExplicitUserCategoryOverride,
  stampUserClassificationProvenance,
} from './productTaxonomy';
import {
  applyUserLineAmountEdit,
  itemAmountForAnalytics,
} from './receiptDiscountAllocation';
import { applyProductIdentityToItem } from './receiptItemIdentity';
import { parseProductSpecification } from './productSpecification';

(global as unknown as { __DEV__: boolean }).__DEV__ = false;

jest.mock('expo-sqlite', () => ({}));
jest.mock('./db', () => ({ initIfNeeded: jest.fn() }), { virtual: true });

import { fixJsonItems } from './categoryBackfill';

const FIXED_NOW = () => new Date('2026-08-22T04:00:00.000Z');

describe('MERUNO user corrections v1 (M1-C)', () => {
  it('A — amount 69→70: raw stays 69, effective 70, provenance recorded', () => {
    const rawItem = {
      name: '麦茶',
      quantity: 1,
      unitPrice: 69,
      lineTotal: 69,
      effectiveLineTotal: 69,
      category: 'snacks_drinks',
    };
    const recognitionSnapshot = { items: [{ ...rawItem }] };

    let userItem: Record<string, unknown> = applyUserLineAmountEdit(
      { ...rawItem },
      70
    ) as Record<string, unknown>;
    userItem = applyItemFieldCorrections(userItem, [
      amountCorrectionInput({
        beforeAmount: 69,
        afterAmount: 70,
        now: FIXED_NOW,
      }),
    ]);

    expect(itemAmountForAnalytics(userItem as any)).toBe(70);
    expect(userItem.amountUserEdited).toBe(true);
    expect(recognitionSnapshot.items[0].lineTotal).toBe(69);
    expect(rawItem.lineTotal).toBe(69);

    const events = readUserCorrections(userItem);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      field: 'item_amount',
      originalValue: 69,
      correctedValue: 70,
      correctedAt: '2026-08-22T04:00:00.000Z',
      source: 'user',
      originalSource: 'ocr',
      contractVersion: USER_CORRECTIONS_CONTRACT_VERSION,
    });
  });

  it('B — repeated amount 69→70→72: effective 72, append-only history', () => {
    let item: Record<string, unknown> = applyUserLineAmountEdit(
      { name: '麦茶', quantity: 1, lineTotal: 69, effectiveLineTotal: 69 },
      70
    ) as Record<string, unknown>;
    item = applyItemFieldCorrections(item, [
      amountCorrectionInput({ beforeAmount: 69, afterAmount: 70, now: FIXED_NOW }),
    ]);
    item = applyUserLineAmountEdit(item as any, 72) as Record<string, unknown>;
    item = applyItemFieldCorrections(item, [
      amountCorrectionInput({
        beforeAmount: 70,
        afterAmount: 72,
        previouslyUserEdited: true,
        now: () => new Date('2026-08-22T05:00:00.000Z'),
      }),
    ]);

    expect(itemAmountForAnalytics(item as any)).toBe(72);
    const events = readUserCorrections(item);
    expect(events.map((e) => [e.originalValue, e.correctedValue])).toEqual([
      [69, 70],
      [70, 72],
    ]);
    expect(latestUserCorrection(item, 'item_amount')?.correctedValue).toBe(72);
    expect(events[1].originalSource).toBe('user');
  });

  it('C — category machine→user retains prior provenance; backfill cannot overwrite', () => {
    const before = {
      name: 'スナック',
      category: 'snacks_drinks',
      classification_source: 'rules',
      classification_version: CLASSIFICATION_VERSION,
      taxonomy_version: TAXONOMY_VERSION,
    };
    let item = {
      ...before,
      category: 'food_ingredients',
      ...stampUserClassificationProvenance(),
    };
    item = applyItemFieldCorrections(item, [
      categoryCorrectionInput({
        beforeCategory: 'snacks_drinks',
        afterCategory: 'food_ingredients',
        beforeItem: before,
        now: FIXED_NOW,
      }),
    ]);

    expect(item.category).toBe('food_ingredients');
    expect(isExplicitUserCategoryOverride(item)).toBe(true);
    expect(item.classification_version).toBeNull();

    const ev = latestUserCorrection(item, 'item_category')!;
    expect(ev).toMatchObject({
      originalValue: 'snacks_drinks',
      correctedValue: 'food_ingredients',
      originalSource: 'machine',
      previousClassificationSource: 'rules',
      previousClassificationVersion: CLASSIFICATION_VERSION,
      taxonomyVersion: TAXONOMY_VERSION,
    });

    const userLayer = fixJsonItems(JSON.stringify([item]), { layer: 'user' });
    expect(userLayer).toBeNull(); // no category mutation
    const preserved = JSON.parse(JSON.stringify([item]))[0];
    expect(preserved.category).toBe('food_ingredients');
    expect(preserved.classification_source).toBe('user');
    expect(readUserCorrections(preserved)).toHaveLength(1);
  });

  it('D — name correction: raw OCR name retained; identity re-resolves on rename', () => {
    const ocrName = 'コカコ一ラ';
    const corrected = 'コカ・コーラ';
    let item: Record<string, unknown> = {
      name: corrected,
      ocr_recognized_name: ocrName,
      category: 'snacks_drinks',
      classification_source: 'dictionary',
      canonical_product_name: 'stale-canonical',
    };
    item = applyItemFieldCorrections(item, [
      nameCorrectionInput({
        beforeName: ocrName,
        afterName: corrected,
        now: FIXED_NOW,
      }),
    ]);
    const resolved = applyProductIdentityToItem(item, {
      finalName: corrected,
      finalCategory: 'snacks_drinks',
      useExistingClassificationEvidence: false,
    });

    expect(resolved.ocr_recognized_name).toBe(ocrName);
    expect(resolved.name).toBe(corrected);
    expect(latestUserCorrection(resolved, 'item_name')).toMatchObject({
      originalValue: ocrName,
      correctedValue: corrected,
      originalSource: 'ocr',
    });
    // Rename path does not blindly keep stale classifier canonical evidence.
    expect(resolved.canonical_product_name).not.toBe('stale-canonical');
  });

  it('E — merchant correction: raw merchant retained; effective merchant drives analytics key input', () => {
    const recognition = { merchant: 'ｾﾌﾞﾝｲﾚﾌﾞﾝ' };
    let analysis = {
      merchant: 'セブンイレブン',
      total: 1000,
      tax: null,
    };
    analysis = appendUserCorrections(analysis, [
      buildUserCorrectionEvent(
        receiptFieldCorrectionInput({
          field: 'merchant',
          originalValue: recognition.merchant,
          correctedValue: 'セブンイレブン',
          now: FIXED_NOW,
        })
      ),
    ]) as typeof analysis;

    expect(recognition.merchant).toBe('ｾﾌﾞﾝｲﾚﾌﾞﾝ');
    expect(analysis.merchant).toBe('セブンイレブン');
    expect(latestUserCorrection(analysis, 'merchant')).toMatchObject({
      originalValue: 'ｾﾌﾞﾝｲﾚﾌﾞﾝ',
      correctedValue: 'セブンイレブン',
      originalSource: 'ocr',
    });
  });

  it('F — date correction: raw date retained; effective date is corrected value', () => {
    const recognition = { transactionDate: '2026/01/02' };
    let analysis = { transactionDate: '2026-01-03' };
    analysis = recordUserCorrection(
      analysis,
      receiptFieldCorrectionInput({
        field: 'transaction_date',
        originalValue: recognition.transactionDate,
        correctedValue: '2026-01-03',
        now: FIXED_NOW,
      })
    );

    expect(recognition.transactionDate).toBe('2026/01/02');
    expect(analysis.transactionDate).toBe('2026-01-03');
    expect(latestUserCorrection(analysis, 'transaction_date')?.correctedValue).toBe(
      '2026-01-03'
    );
  });

  it('G — quantity correction: one occurrence; unit price updates with amount edit path', () => {
    let item: Record<string, unknown> = {
      name: '牛乳',
      quantity: 1,
      lineTotal: 200,
      unitPrice: 200,
      effectiveLineTotal: 200,
    };
    item = { ...item, quantity: 2, quantityUserEdited: true };
    item = applyUserLineAmountEdit(item as any, 200) as Record<string, unknown>; // same paid total, unit recomputed
    item = applyItemFieldCorrections(item, [
      quantityCorrectionInput({
        beforeQuantity: 1,
        afterQuantity: 2,
        now: FIXED_NOW,
      }),
    ]);

    expect(item.quantity).toBe(2);
    expect(item.unitPrice).toBe(100);
    expect(itemAmountForAnalytics(item as any)).toBe(200);
    expect(readUserCorrections(item)).toHaveLength(1);
    // Still a single line / occurrence host — not duplicated events of purchase rows.
    expect(Array.isArray((item as any).occurrences)).toBe(false);
  });

  it('H — restore/rebuild JSON round-trip keeps corrections + effective data; no duplicate events', () => {
    let item: Record<string, unknown> = applyUserLineAmountEdit(
      { name: '麦茶', quantity: 1, lineTotal: 69, category: 'snacks_drinks' },
      70
    ) as Record<string, unknown>;
    item = applyItemFieldCorrections(item, [
      amountCorrectionInput({ beforeAmount: 69, afterAmount: 70, now: FIXED_NOW }),
    ]);

    const user_items_json = JSON.stringify([item]);
    const restored = JSON.parse(user_items_json)[0];
    expect(itemAmountForAnalytics(restored)).toBe(70);
    expect(readUserCorrections(restored)).toHaveLength(1);

    // Rebuild/backfill path that only remaps illegal enums must not drop corrections.
    const fixed = fixJsonItems(user_items_json, { layer: 'user' });
    const after = JSON.parse(fixed?.json ?? user_items_json)[0];
    expect(readUserCorrections(after)).toHaveLength(1);

    // Re-saving without a new edit must not append duplicate correction events.
    const again = applyItemFieldCorrections(after, [
      amountCorrectionInput({ beforeAmount: 70, afterAmount: 70, now: FIXED_NOW }),
    ]);
    expect(readUserCorrections(again)).toHaveLength(1);
  });

  it('I — legacy edited record without correction metadata → legacy_unavailable', () => {
    const legacy = {
      name: '麦茶',
      lineTotal: 70,
      amountUserEdited: true,
    };
    expect(
      resolveLegacyUserOverrideProvenance({
        hasExplicitOverride: legacy.amountUserEdited === true,
        hasCorrectionEvents: readUserCorrections(legacy).length > 0,
      }).status
    ).toBe('legacy_unavailable');
    // Do not invent events.
    expect(buildUserCorrectionEvent(amountCorrectionInput({ beforeAmount: 70, afterAmount: 70 }))).toBeNull();
  });

  it('J — Product Analytics export strips raw correction contents', () => {
    const host = appendUserCorrections(
      { name: '麦茶', lineTotal: 70 },
      [
        buildUserCorrectionEvent(
          amountCorrectionInput({ beforeAmount: 69, afterAmount: 70, now: FIXED_NOW })
        ),
      ]
    );
    const exported = stripUserCorrectionsForAnalyticsExport(host);
    expect((exported as any).user_corrections).toBeUndefined();
    expect(exported.name).toBe('麦茶');
    expect(JSON.stringify(exported)).not.toContain('originalValue');
    expect(JSON.stringify(exported)).not.toContain('correctedValue');
  });

  it('K — discount-aware amount edit still preserves Phase B semantics', () => {
    const discounted = {
      name: '弁当',
      quantity: 1,
      lineTotal: 400,
      line_total: 400,
      effectiveLineTotal: 350,
      discountAllocated: 50,
      category: 'ready_to_eat',
    };
    // Analytics prefer effective when not user-edited.
    expect(itemAmountForAnalytics(discounted)).toBe(350);

    let edited: Record<string, unknown> = applyUserLineAmountEdit(
      discounted,
      360
    ) as Record<string, unknown>;
    edited = applyItemFieldCorrections(edited, [
      amountCorrectionInput({
        beforeAmount: 350,
        afterAmount: 360,
        now: FIXED_NOW,
      }),
    ]);
    expect(itemAmountForAnalytics(edited as any)).toBe(360);
    expect(edited.discountAllocated).toBe(0);
    expect(edited.amountUserEdited).toBe(true);
    expect(latestUserCorrection(edited, 'item_amount')).toMatchObject({
      originalValue: 350,
      correctedValue: 360,
    });
  });

  it('L — spec / purchase quantity separation from M1-B remains intact', () => {
    const spec = parseProductSpecification('お茶500ml×6');
    expect(spec.packCount).toBe(6);
    // Purchase quantity is independent of packCount.
    let item: Record<string, unknown> = {
      name: 'お茶500ml×6',
      quantity: 1,
      lineTotal: 498,
      spec_pack_count: spec.packCount,
      spec_raw_text: spec.rawText,
    };
    item = applyItemFieldCorrections(item, [
      quantityCorrectionInput({
        beforeQuantity: 1,
        afterQuantity: 2,
        now: FIXED_NOW,
      }),
    ]);
    item = { ...item, quantity: 2, quantityUserEdited: true };

    expect(item.quantity).toBe(2);
    expect(item.spec_pack_count).toBe(6);
    expect(latestUserCorrection(item, 'item_quantity')?.correctedValue).toBe(2);
  });

  it('no-op edits do not invent correction events', () => {
    expect(
      buildUserCorrectionEvent(
        amountCorrectionInput({ beforeAmount: 70, afterAmount: 70, now: FIXED_NOW })
      )
    ).toBeNull();
  });
});
