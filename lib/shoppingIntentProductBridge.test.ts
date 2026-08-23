import * as fs from 'fs';
import * as path from 'path';

import type { FrequentProductProfile } from './frequentProductProfile';
import { buildShoppingIntent } from './shoppingIntent';
import { shoppingIntentCreateInputFromFrequentProductProfile } from './shoppingIntentProductBridge';

function familyProfile(
  overrides: Partial<FrequentProductProfile> = {}
): FrequentProductProfile {
  return {
    targetType: 'family',
    key: 'milk',
    displayName: 'milk',
    distinctReceiptCount: 10,
    firstPurchaseAt: 1,
    latestPurchaseAt: 2,
    ...overrides,
  };
}

describe('shoppingIntentProductBridge (R3-B1)', () => {
  it('family: caller displayLabel becomes rawText; familyKey preserved; not the machine key', () => {
    const input = shoppingIntentCreateInputFromFrequentProductProfile(
      familyProfile({ key: 'milk', displayName: 'milk' }),
      { displayLabel: '牛奶' }
    );

    expect(input.rawText).toBe('牛奶');
    expect(input.rawText).not.toBe('milk');
    expect(input.manualResolution).toEqual({ familyKey: 'milk' });
    expect(input.desiredQuantity).toBeUndefined();

    const intent = buildShoppingIntent({
      ...input,
      idFactory: () => 'intent-family-1',
      now: () => new Date('2026-08-23T00:00:00.000Z'),
    });
    expect(intent.rawText).toBe('牛奶');
    expect(intent.resolution?.level).toBe('family');
    expect(intent.resolution?.familyKey).toBe('milk');
    expect(intent.resolution?.resolutionSource).toBe('manual');
    expect(intent.desiredQuantity).toBeNull();
  });

  it('canonical: displayName → rawText; canonical identity from profile.key', () => {
    const profile: FrequentProductProfile = {
      targetType: 'canonical',
      key: '明治 おいしい牛乳',
      displayName: '明治 おいしい牛乳',
      distinctReceiptCount: 4,
      firstPurchaseAt: 10,
      latestPurchaseAt: 20,
    };

    const input = shoppingIntentCreateInputFromFrequentProductProfile(profile);
    expect(input.rawText).toBe('明治 おいしい牛乳');
    expect(input.manualResolution).toEqual({
      canonicalProductName: '明治 おいしい牛乳',
    });

    const intent = buildShoppingIntent({
      ...input,
      idFactory: () => 'intent-canonical-1',
      now: () => new Date('2026-08-23T00:00:00.000Z'),
    });
    expect(intent.resolution?.level).toBe('canonical');
    expect(intent.resolution?.canonicalProductName).toBe('明治 おいしい牛乳');
    expect(intent.resolution?.resolutionSource).toBe('manual');
  });

  it('sku: rawText only — adapter must not fabricate family/canonical identity', () => {
    const profile: FrequentProductProfile = {
      targetType: 'sku',
      key: 'sku:merchant:明治おいしい牛乳900ml',
      displayName: '明治おいしい牛乳 900ml',
      distinctReceiptCount: 3,
      firstPurchaseAt: 1,
      latestPurchaseAt: 2,
    };

    const input = shoppingIntentCreateInputFromFrequentProductProfile(profile);
    expect(input.rawText).toBe('明治おいしい牛乳 900ml');
    expect(input.manualResolution).toBeUndefined();
    expect(JSON.stringify(input)).not.toMatch(/"sku"/i);
    expect(input).not.toHaveProperty('sku');
    expect(input).not.toHaveProperty('skuKey');

    const intent = buildShoppingIntent({
      ...input,
      idFactory: () => 'intent-sku-1',
      now: () => new Date('2026-08-23T00:00:00.000Z'),
    });
    expect(intent.rawText).toBe('明治おいしい牛乳 900ml');
    // Adapter did not inject manual family/canonical. Any resolution is from
    // the existing rawText resolver only — never a fabricated sku field.
    expect(intent.resolution?.resolutionSource).not.toBe('manual');
    expect(JSON.stringify(intent)).not.toMatch(/"skuKey"|sku:/);
  });

  it('does not map distinctReceiptCount / frequency into desiredQuantity', () => {
    const input = shoppingIntentCreateInputFromFrequentProductProfile(
      familyProfile({ distinctReceiptCount: 99 }),
      { displayLabel: '牛奶' }
    );
    expect(input.desiredQuantity).toBeUndefined();

    const intent = buildShoppingIntent({
      ...input,
      idFactory: () => 'intent-qty-1',
      now: () => new Date('2026-08-23T00:00:00.000Z'),
    });
    expect(intent.desiredQuantity).toBeNull();
  });

  it('desiredQuantity only when caller explicitly provides it', () => {
    const input = shoppingIntentCreateInputFromFrequentProductProfile(
      familyProfile(),
      { displayLabel: '牛奶', desiredQuantity: 2 }
    );
    expect(input.desiredQuantity).toBe(2);
  });

  it('allows duplicate create inputs (no dedupe in B1)', () => {
    const a = shoppingIntentCreateInputFromFrequentProductProfile(
      familyProfile(),
      { displayLabel: '牛奶' }
    );
    const b = shoppingIntentCreateInputFromFrequentProductProfile(
      familyProfile(),
      { displayLabel: '牛奶' }
    );
    expect(a).toEqual(b);

    const intentA = buildShoppingIntent({
      ...a,
      idFactory: () => 'dup-a',
      now: () => new Date('2026-08-23T00:00:00.000Z'),
    });
    const intentB = buildShoppingIntent({
      ...b,
      idFactory: () => 'dup-b',
      now: () => new Date('2026-08-23T00:00:00.000Z'),
    });
    expect(intentA.id).not.toBe(intentB.id);
  });

  it('freeze: saveReceipt production path does not complete ShoppingIntents', () => {
    const dbSource = fs.readFileSync(path.join(__dirname, 'db.ts'), 'utf8');
    const saveIdx = dbSource.indexOf('export async function saveReceipt');
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    const afterSave = dbSource.slice(saveIdx, saveIdx + 8000);
    expect(afterSave).not.toMatch(/completeShoppingIntent|markShoppingIntentCompleted/);
    expect(afterSave).not.toMatch(/shoppingIntentRepository/);
    expect(afterSave).not.toMatch(/createShoppingIntent/);

    const bridgeSource = fs.readFileSync(
      path.join(__dirname, 'shoppingIntentProductBridge.ts'),
      'utf8'
    );
    expect(bridgeSource).not.toMatch(/saveReceipt/);
    expect(bridgeSource).not.toMatch(/completeShoppingIntent/);

    const domainSource = fs.readFileSync(
      path.join(__dirname, 'shoppingIntent.ts'),
      'utf8'
    );
    expect(domainSource).not.toMatch(/\bskuKey\b/);
    expect(domainSource).not.toMatch(/level:\s*'sku'|'\s*sku\s*'/);
  });
});
