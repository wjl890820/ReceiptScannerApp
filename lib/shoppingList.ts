/**
 * Meruno Shopping List 1.0 — thin facade over shopping_intents (M1-D).
 *
 * LOCAL-ONLY. No cloud sync, network, or auth.
 * Persisted text snapshot is rendering authority (never rejoin receipts/products).
 * Trusted identity dedupe only for INCOMPLETE merchant_product | personal_product.
 *
 * Lifecycle:
 * - uninstall / local DB deletion ⇒ list lost
 * - receipt cloud restore ⇒ list NOT restored
 */

import { nanoid } from 'nanoid/non-secure';

import type { NextPurchaseCandidate } from './nextPurchaseCandidates';
import {
  createShoppingIntentWithDb,
  decrementActiveShoppingIntentQuantityWithDb,
  deleteCompletedShoppingIntentsWithDb,
  deleteShoppingIntentWithDb,
  ensureShoppingIntentsSchema,
  findActiveShoppingIntentByTrustedIdentityWithDb,
  getShoppingIntentRowWithDb,
  incrementActiveShoppingIntentQuantityWithDb,
  listShoppingIntentRowsWithDb,
  normalizeShoppingListStoredQuantity,
  updateShoppingIntentWithDb,
  type ShoppingIntentDatabase,
  type ShoppingIntentProvenance,
  type ShoppingIntentRow,
  __resetShoppingIntentDbForTests,
} from './shoppingIntentRepository';

export type ShoppingListSourceType = 'manual' | 'history' | 'next_purchase';

export type ShoppingListIdentityKind =
  | 'merchant_product'
  | 'personal_product';

export type ShoppingListItem = {
  id: string;
  text: string;
  /** Positive checklist count in [1, 99]. null desired_quantity reads as 1. */
  quantity: number;
  isCompleted: boolean;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
  sourceType: ShoppingListSourceType;
  sourceIdentityKind: ShoppingListIdentityKind | null;
  sourceIdentityKey: string | null;
};

export const SHOPPING_LIST_QUANTITY_MIN = 1;
export const SHOPPING_LIST_QUANTITY_MAX = 99;

export type ShoppingListAddResult =
  | { status: 'created'; item: ShoppingListItem }
  | { status: 'already_exists'; item: ShoppingListItem }
  | { status: 'rejected'; reason: 'empty_text' };

export type ShoppingListAddOrIncrementResult =
  | { status: 'created'; item: ShoppingListItem }
  | { status: 'incremented'; item: ShoppingListItem }
  | { status: 'max_reached'; item: ShoppingListItem }
  | { status: 'rejected'; reason: 'empty_text' };

export type ShoppingListQuantityResult =
  | { status: 'updated'; item: ShoppingListItem }
  | { status: 'max_reached'; item: ShoppingListItem }
  | { status: 'min_reached'; item: ShoppingListItem }
  | { status: 'not_found' }
  | { status: 'not_active'; item: ShoppingListItem };

export type ShoppingListToggleResult =
  | { status: 'toggled'; item: ShoppingListItem }
  | { status: 'already_active_identity'; item: ShoppingListItem }
  | { status: 'not_found' };

export type AddFromProductDetailInput = {
  displayName: string;
  identityKind?: ShoppingListIdentityKind | null;
  identityKey?: string | null;
};

/** Shopping List presentation quantity from persisted desired_quantity. */
export function effectiveShoppingListQuantity(raw: unknown): number {
  return normalizeShoppingListStoredQuantity(raw, {
    min: SHOPPING_LIST_QUANTITY_MIN,
    max: SHOPPING_LIST_QUANTITY_MAX,
  });
}

export function isSqliteUniqueConstraintError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error ?? '');
  return /UNIQUE constraint failed/i.test(message);
}

function isoToMs(iso: string | null | undefined): number | null {
  if (!iso || typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function requireIsoMs(iso: string): number {
  const ms = isoToMs(iso);
  if (ms == null) return 0;
  return ms;
}

async function openShoppingListDatabase(): Promise<ShoppingIntentDatabase> {
  const { getReceiptsDatabase } = await import('./db');
  return (await getReceiptsDatabase()) as unknown as ShoppingIntentDatabase;
}

export function normalizeShoppingListText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

export function isTrustedShoppingListIdentity(
  kind: unknown,
  key: unknown
): kind is ShoppingListIdentityKind {
  if (kind !== 'merchant_product' && kind !== 'personal_product') return false;
  return typeof key === 'string' && key.trim().length > 0;
}

/** Resolve trusted Shopping List provenance from a Product Detail target. */
export function trustedShoppingIdentityFromProductDetailTarget(
  target: { type: string; key: string } | null | undefined
): {
  identityKind: ShoppingListIdentityKind;
  identityKey: string;
} | null {
  if (!target) return null;
  if (!isTrustedShoppingListIdentity(target.type, target.key)) return null;
  return {
    identityKind: target.type,
    identityKey: target.key.trim(),
  };
}

function parseSourceType(raw: string | null | undefined): ShoppingListSourceType {
  if (raw === 'history' || raw === 'next_purchase' || raw === 'manual') return raw;
  return 'manual';
}

function parseIdentityKind(
  raw: string | null | undefined
): ShoppingListIdentityKind | null {
  if (raw === 'merchant_product' || raw === 'personal_product') return raw;
  return null;
}

export function mapShoppingIntentRowToListItem(
  row: ShoppingIntentRow
): ShoppingListItem | null {
  if (row.status !== 'active' && row.status !== 'completed') return null;
  const text = normalizeShoppingListText(row.raw_text);
  if (!text) return null;
  const kind = parseIdentityKind(row.source_identity_kind);
  const key =
    kind && typeof row.source_identity_key === 'string'
      ? row.source_identity_key.trim() || null
      : null;
  return {
    id: row.id,
    text,
    quantity: effectiveShoppingListQuantity(row.desired_quantity),
    isCompleted: row.status === 'completed',
    completedAt: isoToMs(row.completed_at),
    createdAt: requireIsoMs(row.created_at),
    updatedAt: requireIsoMs(row.updated_at),
    sourceType: parseSourceType(row.source_type),
    sourceIdentityKind: kind && key ? kind : null,
    sourceIdentityKey: kind && key ? key : null,
  };
}

export function sortShoppingListItems(
  items: readonly ShoppingListItem[]
): ShoppingListItem[] {
  const incomplete = items
    .filter((item) => !item.isCompleted)
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
      return left.id.localeCompare(right.id);
    });
  const completed = items
    .filter((item) => item.isCompleted)
    .sort((left, right) => {
      const leftDone = left.completedAt ?? 0;
      const rightDone = right.completedAt ?? 0;
      if (leftDone !== rightDone) return rightDone - leftDone;
      return left.id.localeCompare(right.id);
    });
  return [...incomplete, ...completed];
}

export function shoppingListIdentityKey(
  kind: ShoppingListIdentityKind,
  key: string
): string {
  return `${kind}:${key.trim()}`;
}

export function getActiveShoppingListIdentitySetFromItems(
  items: readonly ShoppingListItem[]
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const item of items) {
    if (item.isCompleted) continue;
    if (!item.sourceIdentityKind || !item.sourceIdentityKey) continue;
    out.add(
      shoppingListIdentityKey(item.sourceIdentityKind, item.sourceIdentityKey)
    );
  }
  return out;
}

export function getActiveShoppingListQuantityMapFromItems(
  items: readonly ShoppingListItem[]
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    if (item.isCompleted) continue;
    if (!item.sourceIdentityKind || !item.sourceIdentityKey) continue;
    out.set(
      shoppingListIdentityKey(item.sourceIdentityKind, item.sourceIdentityKey),
      item.quantity
    );
  }
  return out;
}

function provenanceFor(
  sourceType: ShoppingListSourceType,
  identityKind: ShoppingListIdentityKind | null,
  identityKey: string | null
): ShoppingIntentProvenance {
  const trusted = isTrustedShoppingListIdentity(identityKind, identityKey);
  return {
    sourceType,
    sourceIdentityKind: trusted ? identityKind : null,
    sourceIdentityKey: trusted ? identityKey!.trim() : null,
  };
}

async function addWithTrustedDedupe(
  db: ShoppingIntentDatabase,
  args: {
    text: string;
    sourceType: ShoppingListSourceType;
    identityKind: ShoppingListIdentityKind | null;
    identityKey: string | null;
    now?: () => Date;
    idFactory?: () => string;
  }
): Promise<ShoppingListAddResult> {
  const text = normalizeShoppingListText(args.text);
  if (!text) return { status: 'rejected', reason: 'empty_text' };

  const trusted = isTrustedShoppingListIdentity(
    args.identityKind,
    args.identityKey
  );

  // UX optimization only — UNIQUE index is authoritative for races.
  if (trusted) {
    const existing = await findActiveShoppingIntentByTrustedIdentityWithDb(
      db,
      args.identityKind!,
      args.identityKey!
    );
    if (existing) {
      const item = mapShoppingIntentRowToListItem(existing);
      if (item) return { status: 'already_exists', item };
    }
  }

  try {
    const intent = await createShoppingIntentWithDb(
      db,
      {
        rawText: text,
        // New Shopping List rows persist quantity = 1 (null still reads as 1).
        desiredQuantity: SHOPPING_LIST_QUANTITY_MIN,
        now: args.now,
        idFactory: args.idFactory ?? (() => nanoid()),
      },
      provenanceFor(
        args.sourceType,
        trusted ? args.identityKind : null,
        trusted ? args.identityKey : null
      )
    );
    const row = await getShoppingIntentRowWithDb(db, intent.id);
    const item = row ? mapShoppingIntentRowToListItem(row) : null;
    if (!item) {
      return { status: 'rejected', reason: 'empty_text' };
    }
    return { status: 'created', item };
  } catch (error) {
    if (!trusted || !isSqliteUniqueConstraintError(error)) {
      throw error;
    }
    const existing = await findActiveShoppingIntentByTrustedIdentityWithDb(
      db,
      args.identityKind!,
      args.identityKey!
    );
    const item = existing ? mapShoppingIntentRowToListItem(existing) : null;
    if (item) return { status: 'already_exists', item };
    throw error;
  }
}

async function incrementActiveRow(
  db: ShoppingIntentDatabase,
  id: string,
  now?: () => Date
): Promise<ShoppingListQuantityResult> {
  const before = await getShoppingIntentRowWithDb(db, id);
  if (!before) return { status: 'not_found' };
  const beforeItem = mapShoppingIntentRowToListItem(before);
  if (!beforeItem) return { status: 'not_found' };
  if (before.status !== 'active') {
    return { status: 'not_active', item: beforeItem };
  }
  // Always run atomic normalize+step so legacy RAW is rewritten to 1..99.
  const row = await incrementActiveShoppingIntentQuantityWithDb(db, id, {
    max: SHOPPING_LIST_QUANTITY_MAX,
    min: SHOPPING_LIST_QUANTITY_MIN,
    now,
  });
  const item = row ? mapShoppingIntentRowToListItem(row) : null;
  if (!item) return { status: 'not_found' };
  if (item.quantity >= SHOPPING_LIST_QUANTITY_MAX && beforeItem.quantity >= SHOPPING_LIST_QUANTITY_MAX) {
    return { status: 'max_reached', item };
  }
  return { status: 'updated', item };
}

export async function incrementShoppingListItemQuantityWithDb(
  db: ShoppingIntentDatabase,
  id: string,
  now?: () => Date
): Promise<ShoppingListQuantityResult> {
  return incrementActiveRow(db, id, now);
}

export async function incrementShoppingListItemQuantity(
  id: string
): Promise<ShoppingListQuantityResult> {
  const db = await openShoppingListDatabase();
  return incrementShoppingListItemQuantityWithDb(db, id);
}

export async function decrementShoppingListItemQuantityWithDb(
  db: ShoppingIntentDatabase,
  id: string,
  now?: () => Date
): Promise<ShoppingListQuantityResult> {
  const before = await getShoppingIntentRowWithDb(db, id);
  if (!before) return { status: 'not_found' };
  const beforeItem = mapShoppingIntentRowToListItem(before);
  if (!beforeItem) return { status: 'not_found' };
  if (before.status !== 'active') {
    return { status: 'not_active', item: beforeItem };
  }
  // Always run atomic normalize+step so legacy RAW is rewritten to 1..99.
  const row = await decrementActiveShoppingIntentQuantityWithDb(db, id, {
    min: SHOPPING_LIST_QUANTITY_MIN,
    max: SHOPPING_LIST_QUANTITY_MAX,
    now,
  });
  const item = row ? mapShoppingIntentRowToListItem(row) : null;
  if (!item) return { status: 'not_found' };
  if (
    item.quantity <= SHOPPING_LIST_QUANTITY_MIN &&
    beforeItem.quantity <= SHOPPING_LIST_QUANTITY_MIN
  ) {
    return { status: 'min_reached', item };
  }
  return { status: 'updated', item };
}

export async function decrementShoppingListItemQuantity(
  id: string
): Promise<ShoppingListQuantityResult> {
  const db = await openShoppingListDatabase();
  return decrementShoppingListItemQuantityWithDb(db, id);
}

/**
 * Next Purchase / trusted add-or-increment.
 * Create qty=1, or atomically increment existing active trusted row.
 */
export async function addOrIncrementShoppingListItemFromNextPurchaseWithDb(
  db: ShoppingIntentDatabase,
  candidate: Pick<
    NextPurchaseCandidate,
    'displayName' | 'identityKind' | 'identityKey'
  >,
  options?: { now?: () => Date; idFactory?: () => string }
): Promise<ShoppingListAddOrIncrementResult> {
  const created = await addWithTrustedDedupe(db, {
    text: candidate.displayName,
    sourceType: 'next_purchase',
    identityKind: candidate.identityKind,
    identityKey: candidate.identityKey,
    now: options?.now,
    idFactory: options?.idFactory,
  });
  if (created.status === 'rejected') return created;
  if (created.status === 'created') return created;

  // already_exists → atomic increment of that active row
  const bumped = await incrementActiveRow(db, created.item.id, options?.now);
  if (bumped.status === 'updated') {
    return { status: 'incremented', item: bumped.item };
  }
  if (bumped.status === 'max_reached') {
    return { status: 'max_reached', item: bumped.item };
  }
  // Race: row vanished — retry create once via unique path
  const retry = await addWithTrustedDedupe(db, {
    text: candidate.displayName,
    sourceType: 'next_purchase',
    identityKind: candidate.identityKind,
    identityKey: candidate.identityKey,
    now: options?.now,
    idFactory: options?.idFactory,
  });
  if (retry.status === 'created') return retry;
  if (retry.status === 'already_exists') {
    const again = await incrementActiveRow(db, retry.item.id, options?.now);
    if (again.status === 'updated') {
      return { status: 'incremented', item: again.item };
    }
    if (again.status === 'max_reached') {
      return { status: 'max_reached', item: again.item };
    }
    return { status: 'incremented', item: retry.item };
  }
  return retry;
}

export async function addOrIncrementShoppingListItemFromNextPurchase(
  candidate: Pick<
    NextPurchaseCandidate,
    'displayName' | 'identityKind' | 'identityKey'
  >
): Promise<ShoppingListAddOrIncrementResult> {
  const db = await openShoppingListDatabase();
  return addOrIncrementShoppingListItemFromNextPurchaseWithDb(db, candidate);
}

export async function listShoppingListItemsWithDb(
  db: ShoppingIntentDatabase
): Promise<ShoppingListItem[]> {
  await ensureShoppingIntentsSchema(db);
  const rows = await listShoppingIntentRowsWithDb(db, {
    status: ['active', 'completed'],
  });
  const items: ShoppingListItem[] = [];
  for (const row of rows) {
    const item = mapShoppingIntentRowToListItem(row);
    if (item) items.push(item);
  }
  return sortShoppingListItems(items);
}

export async function listShoppingListItems(): Promise<ShoppingListItem[]> {
  const db = await openShoppingListDatabase();
  return listShoppingListItemsWithDb(db);
}

export async function addManualShoppingListItemWithDb(
  db: ShoppingIntentDatabase,
  text: string,
  options?: { now?: () => Date; idFactory?: () => string }
): Promise<ShoppingListAddResult> {
  return addWithTrustedDedupe(db, {
    text,
    sourceType: 'manual',
    identityKind: null,
    identityKey: null,
    now: options?.now,
    idFactory: options?.idFactory,
  });
}

export async function addManualShoppingListItem(
  text: string
): Promise<ShoppingListAddResult> {
  const db = await openShoppingListDatabase();
  return addManualShoppingListItemWithDb(db, text);
}

export async function addShoppingListItemFromNextPurchaseWithDb(
  db: ShoppingIntentDatabase,
  candidate: Pick<
    NextPurchaseCandidate,
    'displayName' | 'identityKind' | 'identityKey'
  >,
  options?: { now?: () => Date; idFactory?: () => string }
): Promise<ShoppingListAddOrIncrementResult> {
  return addOrIncrementShoppingListItemFromNextPurchaseWithDb(
    db,
    candidate,
    options
  );
}

export async function addShoppingListItemFromNextPurchase(
  candidate: Pick<
    NextPurchaseCandidate,
    'displayName' | 'identityKind' | 'identityKey'
  >
): Promise<ShoppingListAddOrIncrementResult> {
  return addOrIncrementShoppingListItemFromNextPurchase(candidate);
}

export async function addShoppingListItemFromProductDetailWithDb(
  db: ShoppingIntentDatabase,
  input: AddFromProductDetailInput,
  options?: { now?: () => Date; idFactory?: () => string }
): Promise<ShoppingListAddResult> {
  const kind = input.identityKind ?? null;
  const key = input.identityKey ?? null;
  const trusted = isTrustedShoppingListIdentity(kind, key);
  return addWithTrustedDedupe(db, {
    text: input.displayName,
    sourceType: 'history',
    identityKind: trusted ? kind : null,
    identityKey: trusted ? key : null,
    now: options?.now,
    idFactory: options?.idFactory,
  });
}

export async function addShoppingListItemFromProductDetail(
  input: AddFromProductDetailInput
): Promise<ShoppingListAddResult> {
  const db = await openShoppingListDatabase();
  return addShoppingListItemFromProductDetailWithDb(db, input);
}

export async function toggleShoppingListItemCompletedWithDb(
  db: ShoppingIntentDatabase,
  id: string,
  now?: () => Date
): Promise<ShoppingListToggleResult> {
  const row = await getShoppingIntentRowWithDb(db, id);
  if (!row) return { status: 'not_found' };
  if (row.status !== 'active' && row.status !== 'completed') {
    return { status: 'not_found' };
  }

  const nextStatus = row.status === 'completed' ? 'active' : 'completed';
  const currentItem = mapShoppingIntentRowToListItem(row);
  if (!currentItem) return { status: 'not_found' };

  // Uncomplete collision: another active trusted row already owns the slot.
  if (nextStatus === 'active') {
    const kind = currentItem.sourceIdentityKind;
    const key = currentItem.sourceIdentityKey;
    if (kind && key) {
      const blocking = await findActiveShoppingIntentByTrustedIdentityWithDb(
        db,
        kind,
        key
      );
      if (blocking && blocking.id !== id) {
        return { status: 'already_active_identity', item: currentItem };
      }
    }
  }

  try {
    await updateShoppingIntentWithDb(db, id, {
      status: nextStatus,
      now,
    });
  } catch (error) {
    if (nextStatus === 'active' && isSqliteUniqueConstraintError(error)) {
      return { status: 'already_active_identity', item: currentItem };
    }
    throw error;
  }

  const updated = await getShoppingIntentRowWithDb(db, id);
  const item = updated ? mapShoppingIntentRowToListItem(updated) : null;
  if (!item) return { status: 'not_found' };
  return { status: 'toggled', item };
}

export async function toggleShoppingListItemCompleted(
  id: string
): Promise<ShoppingListToggleResult> {
  const db = await openShoppingListDatabase();
  return toggleShoppingListItemCompletedWithDb(db, id);
}

export async function deleteShoppingListItemWithDb(
  db: ShoppingIntentDatabase,
  id: string
): Promise<boolean> {
  return deleteShoppingIntentWithDb(db, id);
}

export async function deleteShoppingListItem(id: string): Promise<boolean> {
  const db = await openShoppingListDatabase();
  return deleteShoppingListItemWithDb(db, id);
}

export async function clearCompletedShoppingListItemsWithDb(
  db: ShoppingIntentDatabase
): Promise<number> {
  return deleteCompletedShoppingIntentsWithDb(db);
}

export async function clearCompletedShoppingListItems(): Promise<number> {
  const db = await openShoppingListDatabase();
  return clearCompletedShoppingListItemsWithDb(db);
}

export async function getActiveShoppingListIdentitySetWithDb(
  db: ShoppingIntentDatabase
): Promise<ReadonlySet<string>> {
  const items = await listShoppingListItemsWithDb(db);
  return getActiveShoppingListIdentitySetFromItems(items);
}

export async function getActiveShoppingListIdentitySet(): Promise<
  ReadonlySet<string>
> {
  const db = await openShoppingListDatabase();
  return getActiveShoppingListIdentitySetWithDb(db);
}

export async function countIncompleteShoppingListItemsWithDb(
  db: ShoppingIntentDatabase
): Promise<number> {
  const items = await listShoppingListItemsWithDb(db);
  return items.filter((item) => !item.isCompleted).length;
}

export async function countIncompleteShoppingListItems(): Promise<number> {
  const db = await openShoppingListDatabase();
  return countIncompleteShoppingListItemsWithDb(db);
}

export function __resetShoppingListDbForTests(): void {
  __resetShoppingIntentDbForTests();
}
