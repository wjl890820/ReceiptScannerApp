/* eslint-disable import/first -- Jest mocks must run before imports. */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

import { buildProductAttributes } from './productIdentityContract';
import { ensureProductIdentityEntitySchema } from './productIdentityEntitySchema';
import {
  PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION,
  buildPersonalDecisionGraph,
  buildPersonalMerchantProductEndpointV1,
  evaluatePersonalRelationship,
  evaluatePersonalRelationshipWithSnapshot,
  type PersonalMerchantProductEndpointV1,
  type PersonalProductCurrentEndpointSnapshot,
  type StoredPersonalProductIdentityDecision,
} from './personalProductIdentityContract';
import { ensurePersonalProductIdentitySchema } from './personalProductIdentitySchema';
import {
  PersonalProductIdentityDomainError,
  buildPersonalDecisionLoadContext,
  createMemoryPersonalProductIdentityDatabase,
  derivePersonalExactAuthority,
  detectCorruptPersonalGraphState,
  detectStalePersonalDecision,
  getDirectPersonalProductDecisionWithDb,
  listPersonalProductIdentityDecisionsWithDb,
  recordPersonalProductIdentityDecisionWithDb,
  shouldSuppressPersonalIdentityPrompt,
} from './personalProductIdentityRepository';

const OWNER = 'user:test-owner';
const OWNER_B = 'user:other-owner';
const INSTALL_OWNER = 'installation:install-1';
const NOW = 1_700_000_000_000;

function endpoint(
  id: string,
  overrides: {
    scope?: string;
    comparisonKey?: string;
    volumeMl?: number;
    packCount?: number;
    identityPipelineVersion?: string;
  } = {}
): PersonalMerchantProductEndpointV1 {
  const entries = [];
  if (overrides.volumeMl != null) {
    entries.push({
      dimension: 'volume' as const,
      value: overrides.volumeMl,
      unit: 'ml',
    });
  }
  if (overrides.packCount != null) {
    entries.push({
      dimension: 'pack_count' as const,
      value: overrides.packCount,
      unit: 'count',
    });
  }
  return buildPersonalMerchantProductEndpointV1({
    merchantProductId: id,
    merchantScopeKey: overrides.scope ?? 'lawson',
    comparisonKey: overrides.comparisonKey ?? `cmp-${id}`,
    attributes: buildProductAttributes(entries),
    identityPipelineVersion: overrides.identityPipelineVersion,
  });
}

function snapshot(
  ...entries: Array<readonly [string, PersonalMerchantProductEndpointV1 | null]>
): PersonalProductCurrentEndpointSnapshot {
  return new Map(entries);
}

function endpointSnapshot(
  ...endpoints: PersonalMerchantProductEndpointV1[]
): PersonalProductCurrentEndpointSnapshot {
  return snapshot(...endpoints.map((row) => [row.merchantProductId, row] as const));
}

function storedRow(
  left: PersonalMerchantProductEndpointV1,
  right: PersonalMerchantProductEndpointV1,
  decision: StoredPersonalProductIdentityDecision['decision'],
  updatedAt = NOW
): StoredPersonalProductIdentityDecision {
  const [leftId, rightId] =
    left.merchantProductId < right.merchantProductId
      ? [left.merchantProductId, right.merchantProductId]
      : [right.merchantProductId, left.merchantProductId];
  const [leftEndpoint, rightEndpoint] =
    left.merchantProductId < right.merchantProductId
      ? [left, right]
      : [right, left];
  return {
    ownerKey: OWNER,
    leftMerchantProductId: leftId,
    rightMerchantProductId: rightId,
    leftMerchantScopeKey: leftEndpoint.merchantScopeKey,
    rightMerchantScopeKey: rightEndpoint.merchantScopeKey,
    leftComparisonKey: leftEndpoint.comparisonKey,
    rightComparisonKey: rightEndpoint.comparisonKey,
    leftStructuralSignature: leftEndpoint.structuralSignature,
    rightStructuralSignature: rightEndpoint.structuralSignature,
    identityPipelineVersion: leftEndpoint.identityPipelineVersion,
    decision,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('G4-1 personal product identity repository', () => {
  it('OWNER — no cross-owner leakage', async () => {
    const db = createMemoryPersonalProductIdentityDatabase();
    const a = endpoint('mp_a');
    const b = endpoint('mp_b');
    await recordPersonalProductIdentityDecisionWithDb(
      db,
      OWNER,
      a,
      b,
      'same_product',
      { nowMs: NOW, currentEndpoints: endpointSnapshot(a, b) }
    );
    expect(await listPersonalProductIdentityDecisionsWithDb(db, OWNER_B)).toEqual([]);
  });

  it('OWNER — installation namespace does not merge into authenticated namespace', async () => {
    const db = createMemoryPersonalProductIdentityDatabase();
    const a = endpoint('mp_a');
    const b = endpoint('mp_b');
    await recordPersonalProductIdentityDecisionWithDb(
      db,
      INSTALL_OWNER,
      a,
      b,
      'same_product',
      { nowMs: NOW, currentEndpoints: endpointSnapshot(a, b) }
    );
    const userContext = buildPersonalDecisionLoadContext(
      await listPersonalProductIdentityDecisionsWithDb(db, OWNER),
      endpointSnapshot(a, b)
    );
    expect(userContext.ok).toBe(true);
    if (userContext.ok) {
      expect(evaluatePersonalRelationship(userContext.context.graph, 'mp_a', 'mp_b').kind).toBe(
        'none'
      );
    }
  });

  describe('EXCLUSIVE TRANSACTION', () => {
    it('write path uses distinct txn handle for owner reads and INSERT', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: endpointSnapshot(a, b) }
      );
      expect(db.exclusiveTransactionCalls).toBeGreaterThan(0);
      expect(db.nonExclusiveTransactionCalls).toBe(0);
      expect(db.txnMetrics.selectCalls).toBeGreaterThanOrEqual(2);
      expect(db.txnMetrics.insertCalls).toBe(1);
    });

    it('outer DB graph-sensitive methods are not used inside exclusive transaction', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const originalWithExclusive = db.withExclusiveTransactionAsync.bind(db);
      db.withExclusiveTransactionAsync = async (task) => {
        await originalWithExclusive(async (txn) => {
          expect(txn).toBe(db.txnDb);
          expect(txn).not.toBe(db);
          await expect(db.getAllAsync('SELECT * FROM personal_product_identity_decisions')).rejects.toThrow(
            'outer_db_used_inside_exclusive_transaction'
          );
          await expect(
            db.getFirstAsync(
              'SELECT * FROM personal_product_identity_decisions WHERE owner_key = ? AND left_merchant_product_id = ? AND right_merchant_product_id = ?',
              [OWNER, 'mp_a', 'mp_b']
            )
          ).rejects.toThrow('outer_db_used_inside_exclusive_transaction');
          await expect(
            db.runAsync('INSERT INTO personal_product_identity_decisions VALUES (?)', ['x'])
          ).rejects.toThrow('outer_db_used_inside_exclusive_transaction');
          await task(txn);
        });
      };
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: endpointSnapshot(a, b) }
      );
    });

    it('conflict rollback leaves no inserted row', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const current = endpointSnapshot(a, b);
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: current }
      );
      const conflict = await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'not_same_product',
        { nowMs: NOW + 1, currentEndpoints: current }
      );
      expect(conflict.ok).toBe(false);
      expect((await listPersonalProductIdentityDecisionsWithDb(db, OWNER)).length).toBe(1);
    });

    it('unexpected exception propagates rather than becoming domain success', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const originalTxnRunAsync = db.txnDb.runAsync.bind(db.txnDb);
      db.txnDb.runAsync = async (source, params) => {
        if (/INSERT INTO personal_product_identity_decisions/i.test(source)) {
          throw new Error('sqlite_unexpected_failure');
        }
        return originalTxnRunAsync(source, params);
      };
      await expect(
        recordPersonalProductIdentityDecisionWithDb(
          db,
          OWNER,
          a,
          b,
          'same_product',
          { nowMs: NOW, currentEndpoints: endpointSnapshot(a, b) }
        )
      ).rejects.toThrow('sqlite_unexpected_failure');
      expect(await listPersonalProductIdentityDecisionsWithDb(db, OWNER)).toEqual([]);
    });
  });

  describe('COMPLETE CURRENT SNAPSHOT', () => {
    it('A=B and A!=C then B=C with complete snapshot rejects personal_not_same_conflict', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const c = endpoint('mp_c');
      const complete = endpointSnapshot(a, b, c);
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: complete }
      );
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        c,
        'not_same_product',
        { nowMs: NOW + 1, currentEndpoints: complete }
      );
      const rejected = await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        b,
        c,
        'same_product',
        { nowMs: NOW + 2, currentEndpoints: complete }
      );
      expect(rejected).toEqual({ ok: false, code: 'personal_not_same_conflict' });
    });

    it('missing required endpoint key returns current_endpoint_context_incomplete with no write', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const c = endpoint('mp_c');
      const complete = endpointSnapshot(a, b, c);
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: complete }
      );
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        c,
        'not_same_product',
        { nowMs: NOW + 1, currentEndpoints: complete }
      );
      const incomplete = await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        b,
        c,
        'same_product',
        { nowMs: NOW + 2, currentEndpoints: endpointSnapshot(b, c) }
      );
      expect(incomplete).toEqual({
        ok: false,
        code: 'current_endpoint_context_incomplete',
        missingMerchantProductIds: ['mp_a'],
      });
      expect(
        await getDirectPersonalProductDecisionWithDb(db, OWNER, 'mp_b', 'mp_c')
      ).toBeNull();
    });

    it('confirmed absent endpoint via null allows stale/inactive semantics', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const c = endpoint('mp_c');
      const complete = endpointSnapshot(a, b, c);
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: complete }
      );
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        c,
        'not_same_product',
        { nowMs: NOW + 1, currentEndpoints: complete }
      );
      const absentA = snapshot(
        ['mp_a', null],
        ['mp_b', b],
        ['mp_c', c]
      );
      const allowed = await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        b,
        c,
        'same_product',
        { nowMs: NOW + 2, currentEndpoints: absentA }
      );
      expect(allowed).toEqual({ ok: true, outcome: 'created' });
    });
  });

  describe('TRANSITIVE NEGATIVE CONSTRAINT', () => {
    it('A=B, B=C, A!=D then C=D rejects personal_not_same_conflict', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const c = endpoint('mp_c');
      const d = endpoint('mp_d');
      const complete = endpointSnapshot(a, b, c, d);
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: complete }
      );
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        b,
        c,
        'same_product',
        { nowMs: NOW + 1, currentEndpoints: complete }
      );
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        d,
        'not_same_product',
        { nowMs: NOW + 2, currentEndpoints: complete }
      );
      const rejected = await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        c,
        d,
        'same_product',
        { nowMs: NOW + 3, currentEndpoints: complete }
      );
      expect(rejected).toEqual({ ok: false, code: 'personal_not_same_conflict' });
    });
  });

  describe('DIRECT DECISIONS', () => {
    it('persists YES / NO / UNSURE', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const c = endpoint('mp_c');
      const complete = endpointSnapshot(a, b, c);

      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: complete }
      );
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        c,
        'not_same_product',
        { nowMs: NOW + 1, currentEndpoints: complete }
      );
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        b,
        c,
        'unsure',
        { nowMs: NOW + 2, currentEndpoints: complete }
      );

      const rows = await listPersonalProductIdentityDecisionsWithDb(db, OWNER);
      expect(rows.map((row) => row.decision).sort()).toEqual([
        'not_same_product',
        'same_product',
        'unsure',
      ]);
    });

    it('duplicate YES / NO / UNSURE are idempotent', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const current = endpointSnapshot(a, b);

      const first = await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: current }
      );
      const second = await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW + 1, currentEndpoints: current }
      );
      expect(first).toEqual({ ok: true, outcome: 'created' });
      expect(second).toEqual({ ok: true, outcome: 'idempotent' });
      expect((await listPersonalProductIdentityDecisionsWithDb(db, OWNER)).length).toBe(1);
    });

    it.each([
      ['same_product', 'not_same_product', 'personal_same_component_conflict'],
      ['not_same_product', 'same_product', 'personal_not_same_conflict'],
      ['same_product', 'unsure', 'decision_conflict'],
      ['not_same_product', 'unsure', 'decision_conflict'],
      ['unsure', 'same_product', 'decision_conflict'],
      ['unsure', 'not_same_product', 'decision_conflict'],
    ] as const)(
      'direct transition %s -> %s returns %s',
      async (existingDecision, nextDecision, expectedCode) => {
        const db = createMemoryPersonalProductIdentityDatabase();
        const a = endpoint('mp_a');
        const b = endpoint('mp_b');
        const current = endpointSnapshot(a, b);
        await recordPersonalProductIdentityDecisionWithDb(
          db,
          OWNER,
          a,
          b,
          existingDecision,
          { nowMs: NOW, currentEndpoints: current }
        );
        const conflict = await recordPersonalProductIdentityDecisionWithDb(
          db,
          OWNER,
          a,
          b,
          nextDecision,
          { nowMs: NOW + 1, currentEndpoints: current }
        );
        expect(conflict).toEqual({
          ok: false,
          code: expectedCode,
          existingDecision,
        });
        expect(
          (await getDirectPersonalProductDecisionWithDb(db, OWNER, a.merchantProductId, b.merchantProductId))
            ?.decision
        ).toBe(existingDecision);
      }
    );
  });

  describe('GRAPH', () => {
    it('A=B and A=B,B=C => A=C', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const c = endpoint('mp_c');
      const current = endpointSnapshot(a, b, c);

      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: current }
      );
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        b,
        c,
        'same_product',
        { nowMs: NOW + 1, currentEndpoints: current }
      );

      const context = buildPersonalDecisionLoadContext(
        await listPersonalProductIdentityDecisionsWithDb(db, OWNER),
        current
      );
      expect(context.ok).toBe(true);
      if (context.ok) {
        expect(evaluatePersonalRelationship(context.context.graph, 'mp_a', 'mp_c').kind).toBe(
          'same_component'
        );
      }
    });

    it('A!=B remains separate', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const current = endpointSnapshot(a, b);
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'not_same_product',
        { nowMs: NOW, currentEndpoints: current }
      );
      const context = buildPersonalDecisionLoadContext(
        await listPersonalProductIdentityDecisionsWithDb(db, OWNER),
        current
      );
      expect(context.ok).toBe(true);
      if (context.ok) {
        expect(evaluatePersonalRelationship(context.context.graph, 'mp_a', 'mp_b').kind).toBe(
          'negative_veto'
        );
      }
    });

    it('rejects NO inside an existing positive component', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const c = endpoint('mp_c');
      const current = endpointSnapshot(a, b, c);
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: current }
      );
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        b,
        c,
        'same_product',
        { nowMs: NOW + 1, currentEndpoints: current }
      );
      const rejected = await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        c,
        'not_same_product',
        { nowMs: NOW + 2, currentEndpoints: current }
      );
      expect(rejected).toEqual({
        ok: false,
        code: 'personal_same_component_conflict',
      });
    });

    it('CORRUPT GRAPH returns fail-closed corrupt result, not veto or authority', () => {
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const c = endpoint('mp_c');
      const current = endpointSnapshot(a, b, c);
      const rows = [
        storedRow(a, b, 'same_product', NOW),
        storedRow(b, c, 'same_product', NOW + 1),
        storedRow(a, c, 'not_same_product', NOW + 2),
      ];
      const graphResult = buildPersonalDecisionGraph(rows, current);
      expect(graphResult.ok).toBe(true);
      if (!graphResult.ok) return;
      const graph = graphResult.graph;
      expect(detectCorruptPersonalGraphState({ rows, graph }).corrupt).toBe(true);
      expect(evaluatePersonalRelationship(graph, 'mp_a', 'mp_c').kind).toBe('corrupt');
      expect(evaluatePersonalRelationship(graph, 'mp_a', 'mp_b').kind).toBe('corrupt');
      expect(derivePersonalExactAuthority(graph, 'mp_a')).toBeNull();
      expect(derivePersonalExactAuthority(graph, 'mp_b')).toBeNull();
    });

    it('incomplete snapshot fails closed for relationship evaluation', () => {
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const rows = [storedRow(a, b, 'same_product')];
      const evaluation = evaluatePersonalRelationshipWithSnapshot(
        rows,
        endpointSnapshot(b),
        'mp_a',
        'mp_b'
      );
      expect(evaluation).toEqual({
        kind: 'context_incomplete',
        missingMerchantProductIds: ['mp_a'],
      });
    });
  });

  describe('UNSURE', () => {
    it('suppresses prompt without creating authority or graph edges', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const current = endpointSnapshot(a, b);
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'unsure',
        { nowMs: NOW, currentEndpoints: current }
      );
      const context = buildPersonalDecisionLoadContext(
        await listPersonalProductIdentityDecisionsWithDb(db, OWNER),
        current
      );
      expect(context.ok).toBe(true);
      if (!context.ok) return;
      expect(
        shouldSuppressPersonalIdentityPrompt(context.context.graph, 'mp_a', 'mp_b')
      ).toBe(true);
      expect(context.context.graph.sameEdges).toEqual([]);
      expect(context.context.graph.notSameEdges).toEqual([]);
      expect(evaluatePersonalRelationship(context.context.graph, 'mp_a', 'mp_b').kind).toBe(
        'unsure_suppressed'
      );
      expect(derivePersonalExactAuthority(context.context.graph, 'mp_a')).toBeNull();
    });

    it('stale unsure does not suppress prompt for changed current pair', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const storedA = endpoint('mp_a', { volumeMl: 500 });
      const b = endpoint('mp_b');
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        storedA,
        b,
        'unsure',
        { nowMs: NOW, currentEndpoints: endpointSnapshot(storedA, b) }
      );
      const rows = await listPersonalProductIdentityDecisionsWithDb(db, OWNER);
      expect(rows).toHaveLength(1);
      const changedA = endpoint('mp_a', { volumeMl: 1000 });
      const stale = detectStalePersonalDecision(rows[0]!, endpointSnapshot(changedA, b));
      expect(stale).toBe(true);
      const context = buildPersonalDecisionLoadContext(rows, endpointSnapshot(changedA, b));
      expect(context.ok).toBe(true);
      if (!context.ok) return;
      expect(
        shouldSuppressPersonalIdentityPrompt(context.context.graph, 'mp_a', 'mp_b')
      ).toBe(false);
      expect(evaluatePersonalRelationship(context.context.graph, 'mp_a', 'mp_b').kind).toBe(
        'none'
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('STALE', () => {
    it('descriptor mismatch marks decision inactive without deleting row', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const stored = endpoint('mp_a', { volumeMl: 500 });
      const b = endpoint('mp_b');
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        stored,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: endpointSnapshot(stored, b) }
      );
      const rows = await listPersonalProductIdentityDecisionsWithDb(db, OWNER);
      const staleCurrent = endpoint('mp_a', { volumeMl: 1000 });
      expect(detectStalePersonalDecision(rows[0]!, endpointSnapshot(staleCurrent, b))).toBe(true);
      const context = buildPersonalDecisionLoadContext(
        rows,
        endpointSnapshot(staleCurrent, b)
      );
      expect(context.ok).toBe(true);
      if (context.ok) {
        expect(derivePersonalExactAuthority(context.context.graph, 'mp_a')).toBeNull();
      }
      expect(rows).toHaveLength(1);
    });
  });

  describe('PIPELINE VERSION', () => {
    it('rejects mismatched pipeline versions for A/B and B/A', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a', {
        identityPipelineVersion: `${PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION}-v1`,
      });
      const b = endpoint('mp_b', {
        identityPipelineVersion: `${PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION}-v2`,
      });
      const current = endpointSnapshot(a, b);
      const forward = await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: current }
      );
      const reverse = await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        b,
        a,
        'same_product',
        { nowMs: NOW + 1, currentEndpoints: current }
      );
      expect(forward).toEqual({ ok: false, code: 'identity_pipeline_version_mismatch' });
      expect(reverse).toEqual({ ok: false, code: 'identity_pipeline_version_mismatch' });
      expect(await listPersonalProductIdentityDecisionsWithDb(db, OWNER)).toEqual([]);
    });
  });

  describe('RESTART / REBUILD', () => {
    it('reloads decisions from a fresh repository instance', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: endpointSnapshot(a, b) }
      );
      expect((await listPersonalProductIdentityDecisionsWithDb(db, OWNER)).length).toBe(1);
    });

    it('survives clearing derived product identity schema', async () => {
      const personalDb = createMemoryPersonalProductIdentityDatabase();
      const derivedDb = { async execAsync() {} };
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      await recordPersonalProductIdentityDecisionWithDb(
        personalDb,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: endpointSnapshot(a, b) }
      );
      await ensureProductIdentityEntitySchema(derivedDb);
      await ensurePersonalProductIdentitySchema(personalDb);
      expect(
        (await listPersonalProductIdentityDecisionsWithDb(personalDb, OWNER)).length
      ).toBe(1);
    });
  });

  describe('AUTHORITY', () => {
    it('valid SAME component returns product_exact personal_manual authority', async () => {
      const db = createMemoryPersonalProductIdentityDatabase();
      const a = endpoint('mp_a');
      const b = endpoint('mp_b');
      const current = endpointSnapshot(a, b);
      await recordPersonalProductIdentityDecisionWithDb(
        db,
        OWNER,
        a,
        b,
        'same_product',
        { nowMs: NOW, currentEndpoints: current }
      );
      const context = buildPersonalDecisionLoadContext(
        await listPersonalProductIdentityDecisionsWithDb(db, OWNER),
        current
      );
      expect(context.ok).toBe(true);
      if (!context.ok) return;
      const authority = derivePersonalExactAuthority(context.context.graph, 'mp_a');
      expect(authority).toEqual({
        identityLevel: 'product_exact',
        sourceTier: 'personal_manual',
        authority: {
          kind: 'personal_product',
          anchorMerchantProductId: 'mp_a',
          memberMerchantProductIds: ['mp_a', 'mp_b'],
        },
      });
      expect(JSON.stringify(authority)).not.toContain('sku_key');
    });
  });

  it('domain error class is used for controlled rollback', () => {
    expect(new PersonalProductIdentityDomainError('decision_conflict').code).toBe(
      'decision_conflict'
    );
  });
});
