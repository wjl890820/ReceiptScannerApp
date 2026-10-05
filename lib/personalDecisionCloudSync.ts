/**
 * DS1 — backup and restore mapping for personal product identity decisions.
 *
 * Row-level append / verify only. Never deletes cloud rows that are absent locally.
 * A different decision or descriptor payload is a conflict: cloud truth stays.
 */

import type * as SQLite from 'expo-sqlite';

import { ensurePersonalProductIdentitySchema } from './personalProductIdentitySchema';

export const PERSONAL_DECISION_CLOUD_TABLE =
  'user_personal_product_identity_decisions';

export const PERSONAL_DECISION_CLOUD_PAGE_SIZE = 200;

const DIRTY_PREFIX = 'personal_decision_backup_dirty_v1:';
const BOOTSTRAP_PREFIX = 'personal_decision_backup_bootstrap_v1:';
const GENERATION_PREFIX = 'personal_decision_backup_generation_v1:';

const DECISION_VALUES = ['same_product', 'not_same_product', 'unsure'] as const;

export type PersonalDecisionValue = (typeof DECISION_VALUES)[number];

const SEMANTIC_FIELDS = [
  'left_merchant_product_id',
  'right_merchant_product_id',
  'left_merchant_scope_key',
  'right_merchant_scope_key',
  'left_comparison_key',
  'right_comparison_key',
  'left_structural_signature',
  'right_structural_signature',
  'identity_pipeline_version',
  'decision',
] as const;

export const PERSONAL_DECISION_CLOUD_SELECT = [
  'user_id',
  ...SEMANTIC_FIELDS,
  'created_at',
  'updated_at',
].join(', ');

export type LocalPersonalDecisionBackupRow = {
  owner_key: string;
  left_merchant_product_id: string;
  right_merchant_product_id: string;
  left_merchant_scope_key: string;
  right_merchant_scope_key: string;
  left_comparison_key: string;
  right_comparison_key: string;
  left_structural_signature: string;
  right_structural_signature: string;
  identity_pipeline_version: string;
  decision: string;
  created_at: number;
  updated_at: number;
};

export type CloudPersonalDecisionPayload = {
  user_id: string;
  left_merchant_product_id: string;
  right_merchant_product_id: string;
  left_merchant_scope_key: string;
  right_merchant_scope_key: string;
  left_comparison_key: string;
  right_comparison_key: string;
  left_structural_signature: string;
  right_structural_signature: string;
  identity_pipeline_version: string;
  decision: PersonalDecisionValue;
  created_at: number;
  updated_at: number;
};

export type PersonalDecisionKvDatabase = {
  execAsync(source: string): Promise<void>;
  runAsync(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<unknown>;
  getFirstAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T | null>;
  getAllAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T[]>;
};

export type PersonalDecisionBackupTxn = {
  runAsync(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<unknown>;
  getFirstAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T | null>;
};

export type PersonalDecisionSyncDatabase = PersonalDecisionKvDatabase & {
  withExclusiveTransactionAsync?(
    task: (txn: PersonalDecisionBackupTxn) => Promise<void>
  ): Promise<void>;
};

type PostgrestErrorLike = {
  code?: string;
  message?: string;
};

type DecisionCloudClient = {
  from: (table: string) => {
    insert: (payload: CloudPersonalDecisionPayload) => Promise<{
      error: PostgrestErrorLike | null;
    }>;
    select: (columns: string) => {
      eq: (
        column: string,
        value: string
      ) => {
        eq: (
          column: string,
          value: string
        ) => {
          eq: (
            column: string,
            value: string
          ) => {
            maybeSingle: () => Promise<{
              data: Record<string, unknown> | null;
              error: PostgrestErrorLike | null;
            }>;
          };
        };
        order: (
          column: string,
          options: { ascending: boolean }
        ) => {
          order: (
            column: string,
            options: { ascending: boolean }
          ) => {
            range: (
              from: number,
              to: number
            ) => Promise<{
              data: Record<string, unknown>[] | null;
              error: PostgrestErrorLike | null;
            }>;
          };
        };
      };
    };
  };
};

export type PersonalDecisionBackupSyncResult = {
  status: 'skipped' | 'ok' | 'table_missing' | 'incomplete';
  uploaded: number;
  idempotent: number;
  conflicts: number;
  errors: number;
};

function loadSupabaseClient(): DecisionCloudClient | null {
  // Loaded on use so decision-row writes do not import React Native.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSupabaseClient } = require('./supabaseClient') as typeof import('./supabaseClient');
  return getSupabaseClient() as DecisionCloudClient | null;
}

export class PersonalDecisionTableMissingError extends Error {
  readonly code = 'personal_decision_table_missing';

  constructor() {
    super('personal_decision_table_missing');
    this.name = 'PersonalDecisionTableMissingError';
  }
}

export function personalDecisionBackupDirtyKvKey(userId: string): string {
  return `${DIRTY_PREFIX}${userId}`;
}

export function personalDecisionBackupBootstrapKvKey(userId: string): string {
  return `${BOOTSTRAP_PREFIX}${userId}`;
}

export function personalDecisionBackupGenerationKvKey(userId: string): string {
  return `${GENERATION_PREFIX}${userId}`;
}

export function parsePersonalDecisionBackupGeneration(value: string | null | undefined): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export class PersonalDecisionBackupGenerationOverflowError extends Error {
  readonly code = 'personal_decision_backup_generation_overflow';

  constructor() {
    super('personal_decision_backup_generation_overflow');
    this.name = 'PersonalDecisionBackupGenerationOverflowError';
  }
}

/**
 * Read of MAX_SAFE_INTEGER is valid. Incrementing it is not.
 * Never wraps, clamps, or returns an unsafe integer.
 */
export function nextPersonalDecisionBackupGeneration(current: number): number {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    current >= Number.MAX_SAFE_INTEGER
  ) {
    throw new PersonalDecisionBackupGenerationOverflowError();
  }
  return current + 1;
}

export function personalDecisionOwnerKeyForUser(userId: string): string {
  const uid = userId.trim();
  return uid ? `user:${uid}` : '';
}

/** Authenticated owner only. `installation:` never maps to a cloud user. */
export function userIdFromPersonalDecisionOwnerKey(ownerKey: string): string | null {
  if (!ownerKey.startsWith('user:')) return null;
  const userId = ownerKey.slice('user:'.length).trim();
  if (!userId || userId.includes(':')) return null;
  return userId;
}

export function isPersonalDecisionTableMissingError(error: unknown): boolean {
  if (error instanceof PersonalDecisionTableMissingError) return true;
  if (!error || typeof error !== 'object') return false;
  const code = String((error as { code?: unknown }).code ?? '');
  const message = String((error as { message?: unknown }).message ?? '');
  if (code === '42P01' || code === 'PGRST205') return true;
  if (/relation\s+["']?.+["']?\s+does not exist/i.test(message)) return true;
  if (
    /could not find the table/i.test(message) &&
    /schema cache/i.test(message)
  ) {
    return true;
  }
  return false;
}

function isUniqueViolation(error: PostgrestErrorLike): boolean {
  if (String(error.code ?? '') === '23505') return true;
  return /duplicate key value violates unique constraint/i.test(
    String(error.message ?? '')
  );
}

function isDecisionValue(value: string): value is PersonalDecisionValue {
  return (DECISION_VALUES as readonly string[]).includes(value);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Cloud personal decision missing ${label}`);
  }
  return value;
}

export function parsePersonalDecisionEpochMs(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`Cloud personal decision malformed ${label}`);
}

export function localPersonalDecisionToCloudPayload(
  userId: string,
  row: LocalPersonalDecisionBackupRow
): CloudPersonalDecisionPayload | null {
  const uid = userId.trim();
  if (!uid || row.owner_key !== personalDecisionOwnerKeyForUser(uid)) return null;
  if (!(row.left_merchant_product_id < row.right_merchant_product_id)) {
    throw new Error('Local personal decision pair is not canonical');
  }
  if (!isDecisionValue(row.decision)) {
    throw new Error('Local personal decision value is invalid');
  }
  return {
    user_id: uid,
    left_merchant_product_id: row.left_merchant_product_id,
    right_merchant_product_id: row.right_merchant_product_id,
    left_merchant_scope_key: row.left_merchant_scope_key,
    right_merchant_scope_key: row.right_merchant_scope_key,
    left_comparison_key: row.left_comparison_key,
    right_comparison_key: row.right_comparison_key,
    left_structural_signature: row.left_structural_signature,
    right_structural_signature: row.right_structural_signature,
    identity_pipeline_version: row.identity_pipeline_version,
    decision: row.decision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function personalDecisionSemanticsMatch(
  cloud: Record<string, unknown>,
  local: CloudPersonalDecisionPayload
): boolean {
  for (const field of SEMANTIC_FIELDS) {
    if (typeof cloud[field] !== 'string' || cloud[field] !== local[field]) {
      return false;
    }
  }
  return true;
}

/**
 * Restore one cloud row exactly. Does not reorder endpoints or rewrite timestamps.
 * Invalid rows throw so the caller can fail the restore before any local write.
 */
export function mapCloudPersonalDecisionToLocalInsert(
  cloud: unknown,
  expectedUserId: string
): LocalPersonalDecisionBackupRow {
  if (!cloud || typeof cloud !== 'object') {
    throw new Error('Cloud personal decision payload is not an object');
  }
  const row = cloud as Record<string, unknown>;
  const expected = expectedUserId.trim();
  const userId = requireText(row.user_id, 'user_id');
  if (!expected || userId !== expected) {
    throw new Error('Cloud personal decision user_id does not match verified restore user');
  }
  const left = requireText(row.left_merchant_product_id, 'left_merchant_product_id');
  const right = requireText(row.right_merchant_product_id, 'right_merchant_product_id');
  if (!(left < right)) {
    throw new Error('Cloud personal decision pair is not canonical');
  }
  const decision = requireText(row.decision, 'decision');
  if (!isDecisionValue(decision)) {
    throw new Error('Cloud personal decision value is invalid');
  }
  const identityPipelineVersion = requireText(
    row.identity_pipeline_version,
    'identity_pipeline_version'
  );
  return {
    owner_key: personalDecisionOwnerKeyForUser(expected),
    left_merchant_product_id: left,
    right_merchant_product_id: right,
    left_merchant_scope_key: requireText(row.left_merchant_scope_key, 'left_merchant_scope_key'),
    right_merchant_scope_key: requireText(
      row.right_merchant_scope_key,
      'right_merchant_scope_key'
    ),
    left_comparison_key: requireText(row.left_comparison_key, 'left_comparison_key'),
    right_comparison_key: requireText(row.right_comparison_key, 'right_comparison_key'),
    left_structural_signature: requireText(
      row.left_structural_signature,
      'left_structural_signature'
    ),
    right_structural_signature: requireText(
      row.right_structural_signature,
      'right_structural_signature'
    ),
    identity_pipeline_version: identityPipelineVersion,
    decision,
    created_at: parsePersonalDecisionEpochMs(row.created_at, 'created_at'),
    updated_at: parsePersonalDecisionEpochMs(row.updated_at, 'updated_at'),
  };
}

async function ensureAppKv(db: PersonalDecisionKvDatabase): Promise<void> {
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS app_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`
  );
}

async function readKv(
  db: PersonalDecisionBackupTxn,
  key: string
): Promise<string | null> {
  const row = await db.getFirstAsync<{ v: string }>(
    `SELECT v FROM app_kv WHERE k = ?`,
    [key]
  );
  return row?.v ?? null;
}

async function writeKv(
  db: PersonalDecisionBackupTxn,
  key: string,
  value: string
): Promise<void> {
  await db.runAsync(`INSERT OR REPLACE INTO app_kv (k, v) VALUES (?, ?)`, [
    key,
    value,
  ]);
}

const ENSURE_APP_KV_SQL =
  `CREATE TABLE IF NOT EXISTS app_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;

/**
 * Publish unsynced user truth inside the same SQLite transaction as the decision.
 * Generation advances by one integer step. Dirty becomes 1. Installation owners no-op.
 */
export async function publishPersonalDecisionBackupInsideTransaction(
  txn: PersonalDecisionBackupTxn,
  ownerKey: string
): Promise<void> {
  const userId = userIdFromPersonalDecisionOwnerKey(ownerKey);
  if (!userId) return;
  await txn.runAsync(ENSURE_APP_KV_SQL);
  const current = parsePersonalDecisionBackupGeneration(
    await readKv(txn, personalDecisionBackupGenerationKvKey(userId))
  );
  const next = nextPersonalDecisionBackupGeneration(current);
  await writeKv(
    txn,
    personalDecisionBackupGenerationKvKey(userId),
    String(next)
  );
  await writeKv(txn, personalDecisionBackupDirtyKvKey(userId), '1');
}

/**
 * Same-decision re-record does not touch the decision row.
 * If dirty is already 1, leave generation and dirty unchanged.
 * If the sync signal was lost, republish dirty and advance generation.
 */
export async function healPersonalDecisionBackupIfCleanInsideTransaction(
  txn: PersonalDecisionBackupTxn,
  ownerKey: string
): Promise<void> {
  const userId = userIdFromPersonalDecisionOwnerKey(ownerKey);
  if (!userId) return;
  await txn.runAsync(ENSURE_APP_KV_SQL);
  const dirty = await readKv(txn, personalDecisionBackupDirtyKvKey(userId));
  if (dirty === '1') return;
  await publishPersonalDecisionBackupInsideTransaction(txn, ownerKey);
}

async function countUserPersonalDecisionsPrepared(
  db: PersonalDecisionBackupTxn,
  userId: string
): Promise<number> {
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM personal_product_identity_decisions WHERE owner_key = ?`,
    [personalDecisionOwnerKeyForUser(userId)]
  );
  const count = Number(row?.c ?? 0);
  return Number.isFinite(count) ? count : 0;
}

export async function countUserPersonalDecisions(
  db: PersonalDecisionKvDatabase,
  userId: string
): Promise<number> {
  await ensurePersonalProductIdentitySchema(db);
  return countUserPersonalDecisionsPrepared(db, userId);
}

/**
 * Same restore refusal as `personalDecisionRestoreBlocked`, without schema DDL.
 * Safe to run on the restore transaction after tables already exist.
 * Installation-owned rows are not this account's truth.
 */
export async function readPersonalDecisionRestoreBlocked(
  db: PersonalDecisionBackupTxn,
  userId: string
): Promise<boolean> {
  const uid = userId.trim();
  if (!uid) return true;
  const dirty = await readKv(db, personalDecisionBackupDirtyKvKey(uid));
  if (dirty === '1') return true;
  const count = await countUserPersonalDecisionsPrepared(db, uid);
  return count > 0;
}

/**
 * Empty-local restore refuses this account's decision truth or unsynced signal.
 * Installation-owned rows are not this account's truth.
 */
export async function personalDecisionRestoreBlocked(
  db: PersonalDecisionKvDatabase,
  userId: string
): Promise<boolean> {
  const uid = userId.trim();
  if (!uid) return true;
  await ensureAppKv(db);
  await ensurePersonalProductIdentitySchema(db);
  return readPersonalDecisionRestoreBlocked(db, uid);
}

async function listUserOwnedLocalDecisions(
  db: PersonalDecisionKvDatabase,
  userId: string
): Promise<LocalPersonalDecisionBackupRow[]> {
  await ensurePersonalProductIdentitySchema(db);
  const ownerKey = personalDecisionOwnerKeyForUser(userId);
  return db.getAllAsync<LocalPersonalDecisionBackupRow>(
    `SELECT
       owner_key,
       left_merchant_product_id,
       right_merchant_product_id,
       left_merchant_scope_key,
       right_merchant_scope_key,
       left_comparison_key,
       right_comparison_key,
       left_structural_signature,
       right_structural_signature,
       identity_pipeline_version,
       decision,
       created_at,
       updated_at
     FROM personal_product_identity_decisions
     WHERE owner_key = ?`,
    [ownerKey]
  );
}

type UploadOneResult =
  | { status: 'inserted' | 'idempotent' | 'conflict' }
  | { status: 'table_missing' }
  | { status: 'error'; message: string };

async function uploadOnePersonalDecision(
  client: DecisionCloudClient,
  payload: CloudPersonalDecisionPayload
): Promise<UploadOneResult> {
  const inserted = await client
    .from(PERSONAL_DECISION_CLOUD_TABLE)
    .insert(payload);
  if (!inserted.error) return { status: 'inserted' };
  if (isPersonalDecisionTableMissingError(inserted.error)) {
    return { status: 'table_missing' };
  }
  if (!isUniqueViolation(inserted.error)) {
    return {
      status: 'error',
      message: inserted.error.message || 'personal decision insert failed',
    };
  }

  const existing = await client
    .from(PERSONAL_DECISION_CLOUD_TABLE)
    .select(PERSONAL_DECISION_CLOUD_SELECT)
    .eq('user_id', payload.user_id)
    .eq('left_merchant_product_id', payload.left_merchant_product_id)
    .eq('right_merchant_product_id', payload.right_merchant_product_id)
    .maybeSingle();
  if (existing.error) {
    if (isPersonalDecisionTableMissingError(existing.error)) {
      return { status: 'table_missing' };
    }
    return {
      status: 'error',
      message: existing.error.message || 'personal decision verify failed',
    };
  }
  if (!existing.data) {
    return {
      status: 'error',
      message: 'personal decision conflict row missing after unique violation',
    };
  }
  if (!personalDecisionSemanticsMatch(existing.data, payload)) {
    return { status: 'conflict' };
  }
  return { status: 'idempotent' };
}

export type PersonalDecisionBackupSyncOptions = {
  /**
   * Test seam. Runs after the local snapshot is confirmed in cloud and
   * before the generation compare that may clear dirty.
   */
  beforeFinalize?: () => Promise<void>;
};

async function finalizePersonalDecisionBackupSnapshot(
  db: PersonalDecisionSyncDatabase,
  userId: string,
  startGeneration: number
): Promise<void> {
  const apply = async (txn: PersonalDecisionBackupTxn) => {
    const currentGeneration = parsePersonalDecisionBackupGeneration(
      await readKv(txn, personalDecisionBackupGenerationKvKey(userId))
    );
    await writeKv(txn, personalDecisionBackupBootstrapKvKey(userId), '1');
    if (currentGeneration === startGeneration) {
      await writeKv(txn, personalDecisionBackupDirtyKvKey(userId), '0');
    }
  };
  if (db.withExclusiveTransactionAsync) {
    await db.withExclusiveTransactionAsync(apply);
    return;
  }
  await apply(db);
}

/**
 * Upload every local `user:${uid}` decision. Missing cloud rows are inserted.
 * Matching rows are left untouched, including created_at.
 * Conflicting rows are left untouched. Installation-owned rows are not read.
 *
 * Generation is read before the row snapshot. Dirty is cleared only when that
 * generation is still current after the cloud round-trip.
 */
export async function syncPersonalDecisionBackup(
  db: PersonalDecisionSyncDatabase,
  userId: string,
  getClient: () => DecisionCloudClient | null = loadSupabaseClient,
  options?: PersonalDecisionBackupSyncOptions
): Promise<PersonalDecisionBackupSyncResult> {
  const uid = userId.trim();
  const empty: PersonalDecisionBackupSyncResult = {
    status: 'skipped',
    uploaded: 0,
    idempotent: 0,
    conflicts: 0,
    errors: 0,
  };
  if (!uid) return empty;

  await ensureAppKv(db);
  const dirty = await readKv(db, personalDecisionBackupDirtyKvKey(uid));
  const bootstrap = await readKv(db, personalDecisionBackupBootstrapKvKey(uid));
  if (dirty !== '1' && bootstrap === '1') return empty;

  const startGeneration = parsePersonalDecisionBackupGeneration(
    await readKv(db, personalDecisionBackupGenerationKvKey(uid))
  );
  const localRows = await listUserOwnedLocalDecisions(db, uid);
  if (localRows.length === 0) {
    if (options?.beforeFinalize) await options.beforeFinalize();
    await finalizePersonalDecisionBackupSnapshot(db, uid, startGeneration);
    return { status: 'ok', uploaded: 0, idempotent: 0, conflicts: 0, errors: 0 };
  }

  const client = getClient();
  if (!client) {
    return { ...empty, status: 'incomplete', errors: localRows.length };
  }

  let uploaded = 0;
  let idempotent = 0;
  let conflicts = 0;
  let errors = 0;
  for (const row of localRows) {
    let payload: CloudPersonalDecisionPayload | null;
    try {
      payload = localPersonalDecisionToCloudPayload(uid, row);
    } catch (error: unknown) {
      errors += 1;
      console.warn(
        '[PersonalDecisionBackup] skipped non-canonical local row:',
        error instanceof Error ? error.message : error
      );
      continue;
    }
    if (!payload) continue;
    const outcome = await uploadOnePersonalDecision(client, payload);
    if (outcome.status === 'table_missing') {
      return {
        status: 'table_missing',
        uploaded,
        idempotent,
        conflicts,
        errors,
      };
    }
    if (outcome.status === 'inserted') uploaded += 1;
    else if (outcome.status === 'idempotent') idempotent += 1;
    else if (outcome.status === 'conflict') {
      conflicts += 1;
      console.warn(
        '[PersonalDecisionBackup] preserved cloud decision for pair',
        payload.left_merchant_product_id,
        payload.right_merchant_product_id
      );
    } else if (outcome.status === 'error') {
      errors += 1;
      console.warn('[PersonalDecisionBackup] row upload failed:', outcome.message);
    }
  }

  if (conflicts > 0 || errors > 0) {
    return { status: 'incomplete', uploaded, idempotent, conflicts, errors };
  }

  if (options?.beforeFinalize) await options.beforeFinalize();
  await finalizePersonalDecisionBackupSnapshot(db, uid, startGeneration);
  return { status: 'ok', uploaded, idempotent, conflicts, errors };
}

export async function fetchAllActiveCloudPersonalDecisionsForUser(
  userId: string,
  getClient: () => unknown = loadSupabaseClient,
  pageSize: number = PERSONAL_DECISION_CLOUD_PAGE_SIZE
): Promise<Record<string, unknown>[]> {
  const client = getClient() as DecisionCloudClient | null;
  if (!client) {
    throw new Error('Supabase client unavailable');
  }
  const uid = userId.trim();
  if (!uid) throw new Error('userId required');
  const cloud = client as unknown as DecisionCloudClient;

  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const to = from + pageSize - 1;
    const { data, error } = await cloud
      .from(PERSONAL_DECISION_CLOUD_TABLE)
      .select(PERSONAL_DECISION_CLOUD_SELECT)
      .eq('user_id', uid)
      .order('left_merchant_product_id', { ascending: true })
      .order('right_merchant_product_id', { ascending: true })
      .range(from, to);
    if (error) {
      if (isPersonalDecisionTableMissingError(error)) {
        throw new PersonalDecisionTableMissingError();
      }
      throw new Error(error.message || 'personal decision fetch failed');
    }
    const page = data ?? [];
    for (const row of page) {
      if (String(row.user_id ?? '').trim() !== uid) {
        throw new Error('Cloud restore refused cross-user personal decision');
      }
      out.push(row);
    }
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return out;
}
