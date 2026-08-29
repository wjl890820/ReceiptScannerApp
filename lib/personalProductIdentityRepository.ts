/**
 * G4-1 — durable local personal product-identity repository.
 *
 * Persists pair decisions only. Builds positive components at runtime.
 */

import * as SQLite from 'expo-sqlite';

import {
  buildPersonalDecisionGraph,
  collectOwnerGraphMerchantProductIds,
  derivePersonalExactAuthority,
  evaluatePersonalRelationship,
  evaluatePersonalRelationshipWithSnapshot,
  normalizePersonalProductIdentityPair,
  precheckPersonalDecisionWrite,
  shouldSuppressPersonalIdentityPrompt,
  validateCurrentEndpointSnapshot,
  type ActivePersonalDecisionRow,
  type PersonalDecisionGraph,
  type PersonalDecisionGraphBuildResult,
  type PersonalExactAuthority,
  type PersonalMerchantProductEndpointV1,
  type PersonalProductCurrentEndpointSnapshot,
  type PersonalProductIdentityDecision,
  type PersonalRelationshipEvaluation,
  type StoredPersonalProductIdentityDecision,
  areInSamePersonalComponent,
  buildPositiveComponents,
  classifyStoredDecisionActivity,
  hasActiveNegativeConstraint,
  isStoredPersonalDecisionActive,
  resolvePersonalProductIdentityOwnerKey,
  validatePersonalMerchantProductEndpointV1,
} from './personalProductIdentityContract';
import {
  ensurePersonalProductIdentitySchema,
  PERSONAL_PRODUCT_IDENTITY_SCHEMA_SQL,
} from './personalProductIdentitySchema';
import type { LocalOwnershipStamp } from './receiptOwnershipContext';

const DB_NAME = 'receipts_v2.db';

const PERSONAL_DECISION_DOMAIN_ERROR_PREFIX = '__personal_decision__:';

export class PersonalProductIdentityDomainError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`${PERSONAL_DECISION_DOMAIN_ERROR_PREFIX}${code}`);
    this.code = code;
  }
}

function isPersonalProductIdentityDomainError(error: unknown): boolean {
  return (
    error instanceof PersonalProductIdentityDomainError ||
    (error instanceof Error &&
      error.message.startsWith(PERSONAL_DECISION_DOMAIN_ERROR_PREFIX))
  );
}

export type PersonalProductIdentityDecisionRow = {
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
  decision: PersonalProductIdentityDecision;
  created_at: number;
  updated_at: number;
};

export type PersonalProductIdentityDb = {
  getAllAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T[]>;
  getFirstAsync<T>(
    source: string,
    params?: SQLite.SQLiteBindParams
  ): Promise<T | null>;
  runAsync(source: string, params?: SQLite.SQLiteBindParams): Promise<unknown>;
};

export type PersonalProductIdentityDatabase = PersonalProductIdentityDb & {
  execAsync(source: string): Promise<void>;
  withExclusiveTransactionAsync(
    task: (txn: PersonalProductIdentityDb) => Promise<void>
  ): Promise<void>;
};

export type RecordPersonalDecisionResult =
  | { ok: true; outcome: 'created' | 'idempotent' }
  | {
      ok: false;
      code:
        | 'owner_unavailable'
        | 'invalid_endpoint'
        | 'self_pair'
        | 'identity_pipeline_version_mismatch'
        | 'current_endpoint_context_incomplete'
        | 'personal_not_same_conflict'
        | 'personal_same_component_conflict'
        | 'decision_conflict';
      existingDecision?: PersonalProductIdentityDecision;
      missingMerchantProductIds?: string[];
    };

export type PersonalDecisionLoadContext = {
  rows: StoredPersonalProductIdentityDecision[];
  graph: PersonalDecisionGraph;
};

export type PersonalDecisionLoadContextResult =
  | { ok: true; context: PersonalDecisionLoadContext }
  | {
      ok: false;
      code: 'current_endpoint_context_incomplete';
      missingMerchantProductIds: string[];
    };

let _db: SQLite.SQLiteDatabase | null = null;
let _schemaReady = false;

export { PERSONAL_PRODUCT_IDENTITY_SCHEMA_SQL, ensurePersonalProductIdentitySchema };

async function getSqliteDb(): Promise<SQLite.SQLiteDatabase> {
  const { initIfNeeded } = await import('./db');
  await initIfNeeded();
  if (!_db) {
    _db = await SQLite.openDatabaseAsync(DB_NAME);
  }
  if (!_schemaReady) {
    await ensurePersonalProductIdentitySchema(_db);
    _schemaReady = true;
  }
  return _db;
}

export function __resetPersonalProductIdentityDbForTests(): void {
  _db = null;
  _schemaReady = false;
}

function rowToStored(
  row: PersonalProductIdentityDecisionRow
): StoredPersonalProductIdentityDecision {
  return {
    ownerKey: row.owner_key,
    leftMerchantProductId: row.left_merchant_product_id,
    rightMerchantProductId: row.right_merchant_product_id,
    leftMerchantScopeKey: row.left_merchant_scope_key,
    rightMerchantScopeKey: row.right_merchant_scope_key,
    leftComparisonKey: row.left_comparison_key,
    rightComparisonKey: row.right_comparison_key,
    leftStructuralSignature: row.left_structural_signature,
    rightStructuralSignature: row.right_structural_signature,
    identityPipelineVersion: row.identity_pipeline_version,
    decision: row.decision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function buildPersonalDecisionLoadContext(
  rows: readonly StoredPersonalProductIdentityDecision[],
  snapshot: PersonalProductCurrentEndpointSnapshot,
  options?: { requiredIds?: readonly string[] }
): PersonalDecisionLoadContextResult {
  const requiredIds =
    options?.requiredIds ?? collectOwnerGraphMerchantProductIds(rows);
  const graphResult = buildPersonalDecisionGraph(rows, snapshot, { requiredIds });
  if (!graphResult.ok) {
    return graphResult;
  }
  return {
    ok: true,
    context: {
      rows: [...rows],
      graph: graphResult.graph,
    },
  };
}

async function listPersonalProductIdentityDecisionsInTransaction(
  db: PersonalProductIdentityDb,
  ownerKey: string
): Promise<StoredPersonalProductIdentityDecision[]> {
  const rows = await db.getAllAsync<PersonalProductIdentityDecisionRow>(
    `SELECT *
     FROM personal_product_identity_decisions
     WHERE owner_key = ?
     ORDER BY updated_at DESC, left_merchant_product_id ASC, right_merchant_product_id ASC`,
    [ownerKey]
  );
  return rows.map(rowToStored);
}

export async function listPersonalProductIdentityDecisionsWithDb(
  db: PersonalProductIdentityDatabase,
  ownerKey: string
): Promise<StoredPersonalProductIdentityDecision[]> {
  await ensurePersonalProductIdentitySchema(db);
  return listPersonalProductIdentityDecisionsInTransaction(db, ownerKey);
}

async function getDirectPersonalProductDecisionInTransaction(
  db: PersonalProductIdentityDb,
  ownerKey: string,
  leftMerchantProductId: string,
  rightMerchantProductId: string
): Promise<StoredPersonalProductIdentityDecision | null> {
  const [leftId, rightId] =
    leftMerchantProductId < rightMerchantProductId
      ? [leftMerchantProductId, rightMerchantProductId]
      : [rightMerchantProductId, leftMerchantProductId];
  const row = await db.getFirstAsync<PersonalProductIdentityDecisionRow>(
    `SELECT *
     FROM personal_product_identity_decisions
     WHERE owner_key = ?
       AND left_merchant_product_id = ?
       AND right_merchant_product_id = ?`,
    [ownerKey, leftId, rightId]
  );
  return row ? rowToStored(row) : null;
}

export async function getDirectPersonalProductDecisionWithDb(
  db: PersonalProductIdentityDatabase,
  ownerKey: string,
  leftMerchantProductId: string,
  rightMerchantProductId: string
): Promise<StoredPersonalProductIdentityDecision | null> {
  await ensurePersonalProductIdentitySchema(db);
  return getDirectPersonalProductDecisionInTransaction(
    db,
    ownerKey,
    leftMerchantProductId,
    rightMerchantProductId
  );
}

function serializeInsertRow(
  ownerKey: string,
  pair: ReturnType<typeof normalizePersonalProductIdentityPair> & { ok: true },
  decision: PersonalProductIdentityDecision,
  nowMs: number
): PersonalProductIdentityDecisionRow {
  const pipelineVersion = pair.pair.left.identityPipelineVersion;
  return {
    owner_key: ownerKey,
    left_merchant_product_id: pair.pair.leftMerchantProductId,
    right_merchant_product_id: pair.pair.rightMerchantProductId,
    left_merchant_scope_key: pair.pair.left.merchantScopeKey,
    right_merchant_scope_key: pair.pair.right.merchantScopeKey,
    left_comparison_key: pair.pair.left.comparisonKey,
    right_comparison_key: pair.pair.right.comparisonKey,
    left_structural_signature: pair.pair.left.structuralSignature,
    right_structural_signature: pair.pair.right.structuralSignature,
    identity_pipeline_version: pipelineVersion,
    decision,
    created_at: nowMs,
    updated_at: nowMs,
  };
}

export async function recordPersonalProductIdentityDecisionWithDb(
  db: PersonalProductIdentityDatabase,
  ownerKey: string,
  leftEndpoint: PersonalMerchantProductEndpointV1,
  rightEndpoint: PersonalMerchantProductEndpointV1,
  decision: PersonalProductIdentityDecision,
  options: {
    nowMs?: number;
    currentEndpoints: PersonalProductCurrentEndpointSnapshot;
  }
): Promise<RecordPersonalDecisionResult> {
  if (!ownerKey.trim()) {
    return { ok: false, code: 'owner_unavailable' };
  }

  const normalized = normalizePersonalProductIdentityPair(leftEndpoint, rightEndpoint);
  if (!normalized.ok) {
    if (normalized.code === 'self_pair') {
      return { ok: false, code: 'self_pair' };
    }
    if (normalized.code === 'identity_pipeline_version_mismatch') {
      return { ok: false, code: 'identity_pipeline_version_mismatch' };
    }
    return { ok: false, code: 'invalid_endpoint' };
  }

  let result: RecordPersonalDecisionResult = {
    ok: false,
    code: 'decision_conflict',
  };

  try {
    await db.withExclusiveTransactionAsync(async (txn) => {
      const existingRows = await listPersonalProductIdentityDecisionsInTransaction(
        txn,
        ownerKey
      );
      const requiredIds = collectOwnerGraphMerchantProductIds(existingRows, [
        normalized.pair.leftMerchantProductId,
        normalized.pair.rightMerchantProductId,
      ]);
      const snapshotValidation = validateCurrentEndpointSnapshot(
        requiredIds,
        options.currentEndpoints
      );
      if (!snapshotValidation.ok) {
        result = {
          ok: false,
          code: 'current_endpoint_context_incomplete',
          missingMerchantProductIds: snapshotValidation.missingMerchantProductIds,
        };
        throw new PersonalProductIdentityDomainError(
          'current_endpoint_context_incomplete'
        );
      }

      const graphResult: PersonalDecisionGraphBuildResult = buildPersonalDecisionGraph(
        existingRows,
        options.currentEndpoints,
        { requiredIds }
      );
      if (!graphResult.ok) {
        result = {
          ok: false,
          code: 'current_endpoint_context_incomplete',
          missingMerchantProductIds: graphResult.missingMerchantProductIds,
        };
        throw new PersonalProductIdentityDomainError(
          'current_endpoint_context_incomplete'
        );
      }

      const existing = await getDirectPersonalProductDecisionInTransaction(
        txn,
        ownerKey,
        normalized.pair.leftMerchantProductId,
        normalized.pair.rightMerchantProductId
      );
      const precheck = precheckPersonalDecisionWrite(
        graphResult.graph,
        existing?.decision ?? null,
        decision,
        normalized.pair.leftMerchantProductId,
        normalized.pair.rightMerchantProductId
      );

      if (!precheck.ok) {
        result = {
          ok: false,
          code: precheck.code,
          existingDecision: precheck.existingDecision,
        };
        throw new PersonalProductIdentityDomainError(precheck.code);
      }

      if (precheck.outcome === 'idempotent') {
        result = { ok: true, outcome: 'idempotent' };
        return;
      }

      const nowMs = options.nowMs ?? Date.now();
      const row = serializeInsertRow(ownerKey, normalized, decision, nowMs);
      await txn.runAsync(
        `INSERT INTO personal_product_identity_decisions (
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.owner_key,
          row.left_merchant_product_id,
          row.right_merchant_product_id,
          row.left_merchant_scope_key,
          row.right_merchant_scope_key,
          row.left_comparison_key,
          row.right_comparison_key,
          row.left_structural_signature,
          row.right_structural_signature,
          row.identity_pipeline_version,
          row.decision,
          row.created_at,
          row.updated_at,
        ]
      );
      result = { ok: true, outcome: 'created' };
    });
  } catch (error: unknown) {
    if (isPersonalProductIdentityDomainError(error)) {
      return result;
    }
    throw error;
  }

  return result;
}

export async function recordPersonalProductIdentityDecision(
  stamp: Pick<LocalOwnershipStamp, 'userId' | 'installationId'>,
  leftEndpoint: PersonalMerchantProductEndpointV1,
  rightEndpoint: PersonalMerchantProductEndpointV1,
  decision: PersonalProductIdentityDecision,
  options: {
    nowMs?: number;
    currentEndpoints: PersonalProductCurrentEndpointSnapshot;
  }
): Promise<RecordPersonalDecisionResult> {
  const ownerKey = resolvePersonalProductIdentityOwnerKey(stamp);
  if (!ownerKey) {
    return { ok: false, code: 'owner_unavailable' };
  }
  const db = await getSqliteDb();
  return recordPersonalProductIdentityDecisionWithDb(
    db,
    ownerKey,
    leftEndpoint,
    rightEndpoint,
    decision,
    options
  );
}

export function listActivePersonalDecisions(
  context: PersonalDecisionLoadContext,
  snapshot: PersonalProductCurrentEndpointSnapshot
): ActivePersonalDecisionRow[] {
  return context.rows.filter((row): row is ActivePersonalDecisionRow =>
    isStoredPersonalDecisionActive(row, snapshot)
  );
}

export function detectStalePersonalDecision(
  row: StoredPersonalProductIdentityDecision,
  snapshot: PersonalProductCurrentEndpointSnapshot
): boolean {
  return classifyStoredDecisionActivity(row, snapshot) === 'inactive';
}

export function detectCorruptPersonalGraphState(
  context: PersonalDecisionLoadContext
): {
  corrupt: boolean;
  corruptMerchantProductIds: string[];
} {
  return {
    corrupt: context.graph.corruptMerchantProductIds.size > 0,
    corruptMerchantProductIds: [...context.graph.corruptMerchantProductIds].sort(),
  };
}

export {
  areInSamePersonalComponent,
  buildPositiveComponents,
  classifyStoredDecisionActivity,
  collectOwnerGraphMerchantProductIds,
  derivePersonalExactAuthority,
  evaluatePersonalRelationship,
  evaluatePersonalRelationshipWithSnapshot,
  hasActiveNegativeConstraint,
  shouldSuppressPersonalIdentityPrompt,
  validateCurrentEndpointSnapshot,
  validatePersonalMerchantProductEndpointV1,
};

export type {
  PersonalExactAuthority,
  PersonalProductCurrentEndpointSnapshot,
  PersonalRelationshipEvaluation,
};

/** In-memory SQLite-compatible store for deterministic unit tests. */
export function createMemoryPersonalProductIdentityDatabase(): PersonalProductIdentityDatabase & {
  rows: Map<string, PersonalProductIdentityDecisionRow>;
  exclusiveTransactionCalls: number;
  nonExclusiveTransactionCalls: number;
  txnDb: PersonalProductIdentityDb & {
    selectCalls: number;
    insertCalls: number;
  };
  txnMetrics: {
    selectCalls: number;
    insertCalls: number;
  };
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
} {
  const rows = new Map<string, PersonalProductIdentityDecisionRow>();
  let exclusiveTransactionCalls = 0;
  let nonExclusiveTransactionCalls = 0;
  let inExclusiveTransaction = false;

  const rowKey = (ownerKey: string, leftId: string, rightId: string) =>
    `${ownerKey}\0${leftId}\0${rightId}`;

  const guardOuterDbAccess = () => {
    if (inExclusiveTransaction) {
      throw new Error('outer_db_used_inside_exclusive_transaction');
    }
  };

  const createDbOps = (
    counters?: { onSelect?: () => void; onInsert?: () => void }
  ): PersonalProductIdentityDb => ({
    async runAsync(source: string, params: SQLite.SQLiteBindParams = []) {
      const values = Array.isArray(params) ? params : [];
      if (/^\s*INSERT INTO personal_product_identity_decisions/i.test(source)) {
        counters?.onInsert?.();
        const row: PersonalProductIdentityDecisionRow = {
          owner_key: String(values[0]),
          left_merchant_product_id: String(values[1]),
          right_merchant_product_id: String(values[2]),
          left_merchant_scope_key: String(values[3]),
          right_merchant_scope_key: String(values[4]),
          left_comparison_key: String(values[5]),
          right_comparison_key: String(values[6]),
          left_structural_signature: String(values[7]),
          right_structural_signature: String(values[8]),
          identity_pipeline_version: String(values[9]),
          decision: String(values[10]) as PersonalProductIdentityDecision,
          created_at: Number(values[11]),
          updated_at: Number(values[12]),
        };
        rows.set(
          rowKey(
            row.owner_key,
            row.left_merchant_product_id,
            row.right_merchant_product_id
          ),
          row
        );
        return { changes: 1 };
      }
      if (/THROW_TEST_ERROR/i.test(source)) {
        throw new Error('sqlite_unexpected_failure');
      }
      return { changes: 0 };
    },
    async getFirstAsync<T>(
      source: string,
      params: SQLite.SQLiteBindParams = []
    ): Promise<T | null> {
      counters?.onSelect?.();
      const values = Array.isArray(params) ? params : [];
      if (
        /FROM personal_product_identity_decisions[\s\S]*left_merchant_product_id = \?/i.test(
          source
        )
      ) {
        const ownerKey = String(values[0]);
        const leftId = String(values[1]);
        const rightId = String(values[2]);
        const row = rows.get(rowKey(ownerKey, leftId, rightId));
        return (row as T) ?? null;
      }
      return null;
    },
    async getAllAsync<T>(
      source: string,
      params: SQLite.SQLiteBindParams = []
    ): Promise<T[]> {
      counters?.onSelect?.();
      const values = Array.isArray(params) ? params : [];
      let list = [...rows.values()];
      if (/WHERE owner_key = \?/i.test(source)) {
        const ownerKey = String(values[0]);
        list = list.filter((row) => row.owner_key === ownerKey);
      }
      list.sort((left, right) => {
        if (left.updated_at !== right.updated_at) {
          return right.updated_at - left.updated_at;
        }
        if (left.left_merchant_product_id !== right.left_merchant_product_id) {
          return left.left_merchant_product_id < right.left_merchant_product_id
            ? -1
            : 1;
        }
        return left.right_merchant_product_id < right.right_merchant_product_id
          ? -1
          : 1;
      });
      return list as T[];
    },
  });

  const txnMetrics = {
    selectCalls: 0,
    insertCalls: 0,
  };

  const txnDb = Object.assign(
    createDbOps({
      onSelect: () => {
        txnMetrics.selectCalls += 1;
      },
      onInsert: () => {
        txnMetrics.insertCalls += 1;
      },
    }),
    {
      get selectCalls() {
        return txnMetrics.selectCalls;
      },
      get insertCalls() {
        return txnMetrics.insertCalls;
      },
    }
  );

  const outerDbOps = createDbOps();

  const api = {
    rows,
    txnDb,
    txnMetrics,
    get exclusiveTransactionCalls() {
      return exclusiveTransactionCalls;
    },
    get nonExclusiveTransactionCalls() {
      return nonExclusiveTransactionCalls;
    },
    async execAsync() {
      guardOuterDbAccess();
    },
    async withExclusiveTransactionAsync(
      task: (txn: PersonalProductIdentityDb) => Promise<void>
    ) {
      exclusiveTransactionCalls += 1;
      const snapshot = new Map(
        [...rows.entries()].map(([key, value]) => [key, { ...value }])
      );
      inExclusiveTransaction = true;
      txnMetrics.selectCalls = 0;
      txnMetrics.insertCalls = 0;
      try {
        await task(txnDb);
      } catch (error) {
        rows.clear();
        for (const [key, value] of snapshot) {
          rows.set(key, value);
        }
        throw error;
      } finally {
        inExclusiveTransaction = false;
      }
    },
    async withTransactionAsync(task: () => Promise<void>) {
      nonExclusiveTransactionCalls += 1;
      await task();
    },
    async runAsync(source: string, params?: SQLite.SQLiteBindParams) {
      guardOuterDbAccess();
      return outerDbOps.runAsync(source, params);
    },
    async getFirstAsync<T>(
      source: string,
      params?: SQLite.SQLiteBindParams
    ): Promise<T | null> {
      guardOuterDbAccess();
      return outerDbOps.getFirstAsync<T>(source, params);
    },
    async getAllAsync<T>(
      source: string,
      params?: SQLite.SQLiteBindParams
    ): Promise<T[]> {
      guardOuterDbAccess();
      return outerDbOps.getAllAsync<T>(source, params);
    },
  };

  return api;
}
