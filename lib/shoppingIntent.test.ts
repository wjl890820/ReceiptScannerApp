import {
  SHOPPING_INTENT_CONTRACT_VERSION,
  applyShoppingIntentUpdate,
  assertNoPriceSnapshotAsTruth,
  buildShoppingIntent,
  extractDesiredQuantity,
  markShoppingIntentArchived,
  markShoppingIntentCompleted,
  resolveShoppingIntentSemantics,
  shoppingIntentMatchKeys,
  shoppingIntentToPriceHistoryTarget,
  stripShoppingIntentForAnalyticsExport,
} from './shoppingIntent';

const FIXED_NOW = () => new Date('2026-08-22T05:00:00.000Z');

describe('MERUNO ShoppingIntent domain v1 (M1-D)', () => {
  it('A — create rawText="牛奶" preserves exact text', () => {
    const intent = buildShoppingIntent({
      rawText: '牛奶',
      now: FIXED_NOW,
      idFactory: () => 'intent-milk-1',
    });
    expect(intent.rawText).toBe('牛奶');
    expect(intent.contractVersion).toBe(SHOPPING_INTENT_CONTRACT_VERSION);
    expect(intent.status).toBe('active');
  });

  it('B — two identical rawText intents get different IDs', () => {
    const a = buildShoppingIntent({
      rawText: '牛奶',
      idFactory: () => 'id-a',
      now: FIXED_NOW,
    });
    const b = buildShoppingIntent({
      rawText: '牛奶',
      idFactory: () => 'id-b',
      now: FIXED_NOW,
    });
    expect(a.rawText).toBe(b.rawText);
    expect(a.id).not.toBe(b.id);
  });

  it('C — unresolved intent builds successfully', () => {
    const intent = buildShoppingIntent({
      rawText: '周末买点火锅用的东西',
      now: FIXED_NOW,
      idFactory: () => 'intent-hotpot',
    });
    expect(intent.rawText).toBe('周末买点火锅用的东西');
    expect(['unknown', 'note']).toContain(intent.intentType);
    expect(intent.resolution == null || intent.resolution.level === 'unresolved').toBe(
      true
    );
  });

  it('D — note intent saves without product resolution', () => {
    const derived = resolveShoppingIntentSemantics('明天记得去 Costco');
    expect(derived.intentType).toBe('note');
    expect(derived.resolution?.level).toBe('unresolved');
    expect(derived.resolution?.familyKey).toBeNull();
    expect(derived.resolution?.canonicalProductName).toBeNull();
  });

  it('E — family-level resolution: 牛奶 → family=milk without requiring canonical', () => {
    const derived = resolveShoppingIntentSemantics('牛奶');
    expect(derived.intentType).toBe('product');
    expect(derived.resolution?.level).toBe('family');
    expect(derived.resolution?.familyKey).toBe('milk');
    expect(derived.resolution?.canonicalProductName).toBeNull();
  });

  it('F — canonical-level representation works', () => {
    const derived = resolveShoppingIntentSemantics('明治おいしい牛乳');
    expect(derived.intentType).toBe('product');
    expect(derived.resolution?.level).toBe('canonical');
    expect(derived.resolution?.canonicalProductName).toBe('明治 おいしい牛乳');
    expect(derived.resolution?.familyKey).toBe('milk');
  });

  it('G — desired spec "牛奶 1L" reuses M1-B parser → volume 1000ml', () => {
    const derived = resolveShoppingIntentSemantics('牛奶 1L');
    expect(derived.desiredSpec?.dimension).toBe('volume');
    expect(derived.desiredSpec?.volumeBaseMl).toBe(1000);
    expect(derived.desiredSpec?.reliability).toBe('exact');
  });

  it('H — desiredQuantity is distinct from purchase_quantity', () => {
    expect(extractDesiredQuantity('牛奶 × 2')).toBe(2);
    const intent = buildShoppingIntent({
      rawText: '牛奶 × 2',
      now: FIXED_NOW,
      idFactory: () => 'qty-1',
    });
    expect(intent.desiredQuantity).toBe(2);
    expect(extractDesiredQuantity('水 500ml×6')).toBeNull();
    const json = JSON.stringify(intent);
    expect(json).not.toContain('purchase_quantity');
    expect(json).not.toContain('purchaseQuantity');
  });

  it('I — complete intent sets completed + completedAt and does not create receipt/purchase', () => {
    const intent = buildShoppingIntent({
      rawText: '牛奶',
      now: FIXED_NOW,
      idFactory: () => 'complete-1',
    });
    const completed = markShoppingIntentCompleted(
      intent,
      () => new Date('2026-08-22T06:00:00.000Z')
    );
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBe('2026-08-22T06:00:00.000Z');
    expect(JSON.stringify(completed)).not.toContain('receiptId');
  });

  it('J — archive does not invent receipt history side effects', () => {
    const intent = buildShoppingIntent({
      rawText: '鸡蛋',
      now: FIXED_NOW,
      idFactory: () => 'arch-1',
    });
    const archived = markShoppingIntentArchived(intent, FIXED_NOW);
    expect(archived.status).toBe('archived');
    expect(JSON.stringify(archived)).not.toContain('receiptId');
  });

  it('M — rawText survives resolution changes', () => {
    const intent = buildShoppingIntent({
      rawText: '明治牛乳 两盒',
      now: FIXED_NOW,
      idFactory: () => 'raw-1',
    });
    const updated = applyShoppingIntentUpdate(intent, {
      manualResolution: { familyKey: 'milk' },
      now: () => new Date('2026-08-22T07:00:00.000Z'),
    });
    expect(updated.rawText).toBe('明治牛乳 两盒');
    expect(updated.resolution?.resolutionSource).toBe('manual');
    expect(updated.resolution?.familyKey).toBe('milk');
  });

  it('N — future identity keys are sufficient for family-level matching', () => {
    const intent = buildShoppingIntent({
      rawText: '牛奶',
      now: FIXED_NOW,
      idFactory: () => 'match-1',
    });
    const keys = shoppingIntentMatchKeys(intent);
    expect(keys.familyKey).toBe('milk');
    expect(keys.rawText).toBe('牛奶');
    expect(keys.familyKey).not.toBe(keys.rawText);
  });

  it('P — no historical price stored as ShoppingIntent source of truth', () => {
    const intent = buildShoppingIntent({
      rawText: '牛奶',
      now: FIXED_NOW,
      idFactory: () => 'noprice-1',
    });
    expect(() => assertNoPriceSnapshotAsTruth(intent)).not.toThrow();
    expect(JSON.stringify(intent)).not.toMatch(/lastPrice|lowestPrice|averagePrice/);
    expect(shoppingIntentToPriceHistoryTarget(intent)).toEqual({
      type: 'family',
      key: 'milk',
    });
  });

  it('Q — Product Analytics payload contains no raw shopping content', () => {
    const intent = buildShoppingIntent({
      rawText: '明治おいしい牛乳 900ml',
      now: FIXED_NOW,
      idFactory: () => 'analytics-1',
    });
    const payload = stripShoppingIntentForAnalyticsExport(intent);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('明治');
    expect(serialized).not.toContain('おいしい牛乳');
    expect(serialized).not.toContain('900ml');
    expect(payload).not.toHaveProperty('rawText');
    expect(payload).not.toHaveProperty('desiredQuantity');
    expect(payload).not.toHaveProperty('resolution');
  });

  it('R — mark helpers do not invent receipt/purchase side effects', () => {
    const intent = buildShoppingIntent({
      rawText: '牛奶',
      now: FIXED_NOW,
      idFactory: () => 'side-1',
    });
    const completed = markShoppingIntentCompleted(intent, FIXED_NOW);
    const archived = markShoppingIntentArchived(intent, FIXED_NOW);
    expect(completed.status).toBe('completed');
    expect(archived.status).toBe('archived');
    expect(JSON.stringify(completed)).not.toContain('purchaseOccurrence');
    expect(JSON.stringify(archived)).not.toContain('"receipt"');
  });
});
