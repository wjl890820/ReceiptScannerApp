/**
 * G4-1 — personal manual product identity contract (pure).
 *
 * User/private identity knowledge. No UI, no candidate generation.
 */

import type { ProductAttributes } from './productIdentityContract';
import { PRODUCT_IDENTITY_RESOLVER_VERSION } from './productIdentityContract';
import type { LocalOwnershipStamp } from './receiptOwnershipContext';
import { isUnknownMerchantScopeKey } from './productIdentityResolver';

export const PERSONAL_PRODUCT_IDENTITY_ENDPOINT_VERSION = 'personal-endpoint-v1' as const;

export const PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION =
  `${PRODUCT_IDENTITY_RESOLVER_VERSION}+${PERSONAL_PRODUCT_IDENTITY_ENDPOINT_VERSION}` as const;

export type PersonalProductIdentityDecision =
  | 'same_product'
  | 'not_same_product'
  | 'unsure';

export type PersonalMerchantProductEndpointV1 = {
  merchantProductId: string;
  merchantScopeKey: string;
  comparisonKey: string;
  structuralSignature: string;
  identityPipelineVersion: string;
};

export type PersonalProductIdentityPair = {
  left: PersonalMerchantProductEndpointV1;
  right: PersonalMerchantProductEndpointV1;
  leftMerchantProductId: string;
  rightMerchantProductId: string;
};

export type PersonalExactAuthority = {
  identityLevel: 'product_exact';
  sourceTier: 'personal_manual';
  authority: {
    kind: 'personal_product';
    anchorMerchantProductId: string;
    memberMerchantProductIds: string[];
  };
};

export type PersonalProductCurrentEndpointSnapshot = ReadonlyMap<
  string,
  PersonalMerchantProductEndpointV1 | null
>;

export type PersonalRelationshipEvaluation =
  | {
      kind: 'context_incomplete';
      missingMerchantProductIds: string[];
    }
  | {
      kind: 'corrupt';
      corruptMerchantProductIds: string[];
    }
  | { kind: 'negative_veto'; leftMerchantProductId: string; rightMerchantProductId: string }
  | { kind: 'same_component'; authority: PersonalExactAuthority }
  | { kind: 'unsure_suppressed' }
  | { kind: 'none' };

export type PersonalEndpointValidationIssue =
  | 'blank_merchant_product_id'
  | 'blank_merchant_scope_key'
  | 'unknown_merchant_scope'
  | 'blank_comparison_key'
  | 'blank_structural_signature'
  | 'blank_identity_pipeline_version'
  | 'identity_pipeline_version_mismatch';

const IDENTITY_STRUCTURAL_DIMENSIONS = [
  'volume',
  'mass',
  'count',
  'pack_count',
  'roll_count',
  'length',
  'total_volume',
  'size',
  'color',
  'model',
  'battery_size',
  'ply',
  'connector',
] as const;

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolvePersonalProductIdentityOwnerKey(
  stamp: Pick<LocalOwnershipStamp, 'userId' | 'installationId'>
): string | null {
  const userId = nonEmpty(stamp.userId);
  if (userId) return `user:${userId}`;
  const installationId = nonEmpty(stamp.installationId);
  if (installationId) return `installation:${installationId}`;
  return null;
}

export function buildStructuralSignatureFromAttributes(
  attributes: ProductAttributes | null | undefined
): string {
  if (!attributes?.entries?.length) {
    return 'struct-v1:empty';
  }

  const relevant = attributes.entries
    .filter((entry) =>
      (IDENTITY_STRUCTURAL_DIMENSIONS as readonly string[]).includes(entry.dimension)
    )
    .map((entry) => ({
      dimension: entry.dimension,
      value: entry.value,
      unit: entry.unit ?? null,
    }))
    .sort(
      (left, right) =>
        left.dimension.localeCompare(right.dimension) ||
        String(left.value).localeCompare(String(right.value)) ||
        String(left.unit).localeCompare(String(right.unit))
    );

  return `struct-v1:${JSON.stringify(relevant)}`;
}

export function buildPersonalMerchantProductEndpointV1(input: {
  merchantProductId: string;
  merchantScopeKey: string;
  comparisonKey: string;
  attributes: ProductAttributes | null | undefined;
  identityPipelineVersion?: string;
}): PersonalMerchantProductEndpointV1 {
  return {
    merchantProductId: input.merchantProductId.trim(),
    merchantScopeKey: input.merchantScopeKey.trim(),
    comparisonKey: input.comparisonKey.trim(),
    structuralSignature: buildStructuralSignatureFromAttributes(input.attributes),
    identityPipelineVersion:
      input.identityPipelineVersion?.trim() ||
      PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION,
  };
}

export function validatePersonalMerchantProductEndpointV1(
  endpoint: PersonalMerchantProductEndpointV1,
  options?: { expectedPipelineVersion?: string }
):
  | { ok: true }
  | { ok: false; issues: PersonalEndpointValidationIssue[] } {
  const issues: PersonalEndpointValidationIssue[] = [];

  if (!nonEmpty(endpoint.merchantProductId)) {
    issues.push('blank_merchant_product_id');
  }
  if (!nonEmpty(endpoint.merchantScopeKey)) {
    issues.push('blank_merchant_scope_key');
  } else if (isUnknownMerchantScopeKey(endpoint.merchantScopeKey)) {
    issues.push('unknown_merchant_scope');
  }
  if (!nonEmpty(endpoint.comparisonKey)) {
    issues.push('blank_comparison_key');
  }
  if (!nonEmpty(endpoint.structuralSignature)) {
    issues.push('blank_structural_signature');
  }
  if (!nonEmpty(endpoint.identityPipelineVersion)) {
    issues.push('blank_identity_pipeline_version');
  } else if (
    options?.expectedPipelineVersion &&
    endpoint.identityPipelineVersion !== options.expectedPipelineVersion
  ) {
    issues.push('identity_pipeline_version_mismatch');
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

export function canonicalPersonalProductPairKey(
  leftMerchantProductId: string,
  rightMerchantProductId: string
): string {
  return `${leftMerchantProductId}\0${rightMerchantProductId}`;
}

export function normalizePersonalProductIdentityPair(
  leftInput: PersonalMerchantProductEndpointV1,
  rightInput: PersonalMerchantProductEndpointV1
):
  | { ok: true; pair: PersonalProductIdentityPair }
  | {
      ok: false;
      code:
        | 'self_pair'
        | 'invalid_endpoint'
        | 'identity_pipeline_version_mismatch';
      issues?: PersonalEndpointValidationIssue[];
    } {
  const leftValidation = validatePersonalMerchantProductEndpointV1(leftInput);
  const rightValidation = validatePersonalMerchantProductEndpointV1(rightInput);
  if (!leftValidation.ok || !rightValidation.ok) {
    return {
      ok: false,
      code: 'invalid_endpoint',
      issues: [
        ...(leftValidation.ok ? [] : leftValidation.issues),
        ...(rightValidation.ok ? [] : rightValidation.issues),
      ],
    };
  }

  if (leftInput.merchantProductId === rightInput.merchantProductId) {
    return { ok: false, code: 'self_pair' };
  }

  if (leftInput.identityPipelineVersion !== rightInput.identityPipelineVersion) {
    return { ok: false, code: 'identity_pipeline_version_mismatch' };
  }

  const [left, right, leftMerchantProductId, rightMerchantProductId] =
    leftInput.merchantProductId < rightInput.merchantProductId
      ? [
          leftInput,
          rightInput,
          leftInput.merchantProductId,
          rightInput.merchantProductId,
        ]
      : [
          rightInput,
          leftInput,
          rightInput.merchantProductId,
          leftInput.merchantProductId,
        ];

  return {
    ok: true,
    pair: {
      left,
      right,
      leftMerchantProductId,
      rightMerchantProductId,
    },
  };
}

export type StoredPersonalProductIdentityDecision = {
  ownerKey: string;
  leftMerchantProductId: string;
  rightMerchantProductId: string;
  leftMerchantScopeKey: string;
  rightMerchantScopeKey: string;
  leftComparisonKey: string;
  rightComparisonKey: string;
  leftStructuralSignature: string;
  rightStructuralSignature: string;
  identityPipelineVersion: string;
  decision: PersonalProductIdentityDecision;
  createdAt: number;
  updatedAt: number;
};

export type ActivePersonalDecisionRow = StoredPersonalProductIdentityDecision & {
  active: true;
};

export function endpointDescriptorMatchesStored(
  current: PersonalMerchantProductEndpointV1,
  storedRow: StoredPersonalProductIdentityDecision,
  side: 'left' | 'right'
): boolean {
  const merchantProductId =
    side === 'left'
      ? storedRow.leftMerchantProductId
      : storedRow.rightMerchantProductId;
  const scopeKey =
    side === 'left'
      ? storedRow.leftMerchantScopeKey
      : storedRow.rightMerchantScopeKey;
  const comparisonKey =
    side === 'left'
      ? storedRow.leftComparisonKey
      : storedRow.rightComparisonKey;
  const structuralSignature =
    side === 'left'
      ? storedRow.leftStructuralSignature
      : storedRow.rightStructuralSignature;

  return (
    current.merchantProductId === merchantProductId &&
    current.merchantScopeKey === scopeKey &&
    current.comparisonKey === comparisonKey &&
    current.structuralSignature === structuralSignature &&
    current.identityPipelineVersion === storedRow.identityPipelineVersion
  );
}

export type StoredDecisionActivity = 'active' | 'inactive' | 'unknown';

export function collectOwnerGraphMerchantProductIds(
  rows: readonly StoredPersonalProductIdentityDecision[],
  additionalIds: readonly string[] = []
): string[] {
  const ids = new Set<string>(additionalIds);
  for (const row of rows) {
    ids.add(row.leftMerchantProductId);
    ids.add(row.rightMerchantProductId);
  }
  return [...ids].sort();
}

export function validateCurrentEndpointSnapshot(
  requiredIds: readonly string[],
  snapshot: PersonalProductCurrentEndpointSnapshot
):
  | { ok: true }
  | {
      ok: false;
      code: 'current_endpoint_context_incomplete';
      missingMerchantProductIds: string[];
    } {
  const missingMerchantProductIds = requiredIds
    .filter((id) => !snapshot.has(id))
    .sort();
  if (missingMerchantProductIds.length > 0) {
    return {
      ok: false,
      code: 'current_endpoint_context_incomplete',
      missingMerchantProductIds,
    };
  }
  return { ok: true };
}

export function classifyStoredDecisionActivity(
  row: StoredPersonalProductIdentityDecision,
  snapshot: PersonalProductCurrentEndpointSnapshot
): StoredDecisionActivity {
  if (!snapshot.has(row.leftMerchantProductId)) return 'unknown';
  if (!snapshot.has(row.rightMerchantProductId)) return 'unknown';

  const leftCurrent = snapshot.get(row.leftMerchantProductId);
  const rightCurrent = snapshot.get(row.rightMerchantProductId);
  if (leftCurrent == null || rightCurrent == null) {
    return 'inactive';
  }

  return endpointDescriptorMatchesStored(leftCurrent, row, 'left') &&
    endpointDescriptorMatchesStored(rightCurrent, row, 'right')
    ? 'active'
    : 'inactive';
}

export function isStoredPersonalDecisionActive(
  row: StoredPersonalProductIdentityDecision,
  snapshot: PersonalProductCurrentEndpointSnapshot
): row is ActivePersonalDecisionRow {
  return classifyStoredDecisionActivity(row, snapshot) === 'active';
}

export type PersonalDecisionGraphBuildResult =
  | { ok: true; graph: PersonalDecisionGraph }
  | {
      ok: false;
      code: 'current_endpoint_context_incomplete';
      missingMerchantProductIds: string[];
    };

export type PersonalDecisionGraph = {
  sameEdges: Array<{ left: string; right: string }>;
  notSameEdges: Array<{ left: string; right: string }>;
  unsurePairKeys: Set<string>;
  corruptMerchantProductIds: Set<string>;
};

class UnionFind {
  private readonly parent = new Map<string, string>();

  add(node: string): void {
    if (!this.parent.has(node)) {
      this.parent.set(node, node);
    }
  }

  find(node: string): string {
    this.add(node);
    let root = node;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    let current = node;
    while (this.parent.get(current) !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      this.parent.set(rightRoot, leftRoot);
    }
  }

  members(root: string): string[] {
    const target = this.find(root);
    return [...this.parent.keys()].filter((node) => this.find(node) === target);
  }

  nodes(): string[] {
    return [...this.parent.keys()];
  }
}

export function buildPersonalDecisionGraph(
  rows: readonly StoredPersonalProductIdentityDecision[],
  snapshot: PersonalProductCurrentEndpointSnapshot,
  options?: { requiredIds?: readonly string[] }
): PersonalDecisionGraphBuildResult {
  const requiredIds =
    options?.requiredIds ?? collectOwnerGraphMerchantProductIds(rows);
  const snapshotValidation = validateCurrentEndpointSnapshot(requiredIds, snapshot);
  if (!snapshotValidation.ok) {
    return snapshotValidation;
  }

  const sameEdges: Array<{ left: string; right: string }> = [];
  const notSameEdges: Array<{ left: string; right: string }> = [];
  const unsurePairKeys = new Set<string>();

  for (const row of rows) {
    if (classifyStoredDecisionActivity(row, snapshot) !== 'active') continue;
    const pairKey = canonicalPersonalProductPairKey(
      row.leftMerchantProductId,
      row.rightMerchantProductId
    );
    if (row.decision === 'same_product') {
      sameEdges.push({
        left: row.leftMerchantProductId,
        right: row.rightMerchantProductId,
      });
    } else if (row.decision === 'not_same_product') {
      notSameEdges.push({
        left: row.leftMerchantProductId,
        right: row.rightMerchantProductId,
      });
    } else {
      unsurePairKeys.add(pairKey);
    }
  }

  const uf = new UnionFind();
  for (const edge of sameEdges) {
    uf.union(edge.left, edge.right);
  }

  const corruptMerchantProductIds = new Set<string>();
  for (const edge of notSameEdges) {
    if (uf.find(edge.left) === uf.find(edge.right)) {
      for (const member of uf.members(edge.left)) {
        corruptMerchantProductIds.add(member);
      }
    }
  }

  return {
    ok: true,
    graph: {
      sameEdges,
      notSameEdges,
      unsurePairKeys,
      corruptMerchantProductIds,
    },
  };
}

export function buildPositiveComponents(
  graph: PersonalDecisionGraph
): Map<string, string[]> {
  const uf = new UnionFind();
  for (const edge of graph.sameEdges) {
    uf.union(edge.left, edge.right);
  }
  for (const node of graph.corruptMerchantProductIds) {
    uf.add(node);
  }

  const byRoot = new Map<string, string[]>();
  for (const node of uf.nodes()) {
    if (graph.corruptMerchantProductIds.has(node)) continue;
    const root = uf.find(node);
    const members = byRoot.get(root) ?? [];
    members.push(node);
    byRoot.set(root, members);
  }

  for (const members of byRoot.values()) {
    members.sort();
  }
  return byRoot;
}

function hasCrossComponentNegativeConstraint(
  graph: PersonalDecisionGraph,
  leftComponent: Set<string>,
  rightComponent: Set<string>
): boolean {
  for (const edge of graph.notSameEdges) {
    const leftInLeft = leftComponent.has(edge.left);
    const rightInRight = rightComponent.has(edge.right);
    const leftInRight = rightComponent.has(edge.left);
    const rightInLeft = leftComponent.has(edge.right);
    if ((leftInLeft && rightInRight) || (leftInRight && rightInLeft)) {
      return true;
    }
  }
  return false;
}

export function areInSamePersonalComponent(
  graph: PersonalDecisionGraph,
  leftMerchantProductId: string,
  rightMerchantProductId: string
): boolean {
  if (graph.corruptMerchantProductIds.has(leftMerchantProductId)) return false;
  if (graph.corruptMerchantProductIds.has(rightMerchantProductId)) return false;
  const uf = new UnionFind();
  for (const edge of graph.sameEdges) {
    uf.union(edge.left, edge.right);
  }
  return uf.find(leftMerchantProductId) === uf.find(rightMerchantProductId);
}

export function hasActiveNegativeConstraint(
  graph: PersonalDecisionGraph,
  leftMerchantProductId: string,
  rightMerchantProductId: string
): boolean {
  const uf = new UnionFind();
  for (const edge of graph.sameEdges) {
    uf.union(edge.left, edge.right);
  }

  const leftRoot = uf.find(leftMerchantProductId);
  const rightRoot = uf.find(rightMerchantProductId);
  const leftComponent = new Set(uf.members(leftRoot));
  const rightComponent = new Set(uf.members(rightRoot));

  return hasCrossComponentNegativeConstraint(graph, leftComponent, rightComponent);
}

export function derivePersonalExactAuthority(
  graph: PersonalDecisionGraph,
  merchantProductId: string
): PersonalExactAuthority | null {
  if (graph.corruptMerchantProductIds.has(merchantProductId)) {
    return null;
  }

  const components = buildPositiveComponents(graph);
  for (const members of components.values()) {
    if (!members.includes(merchantProductId)) continue;
    const anchorMerchantProductId = members[0]!;
    return {
      identityLevel: 'product_exact',
      sourceTier: 'personal_manual',
      authority: {
        kind: 'personal_product',
        anchorMerchantProductId,
        memberMerchantProductIds: [...members],
      },
    };
  }
  return null;
}

export function shouldSuppressPersonalIdentityPrompt(
  graph: PersonalDecisionGraph,
  leftMerchantProductId: string,
  rightMerchantProductId: string
): boolean {
  const pairKey = canonicalPersonalProductPairKey(
    leftMerchantProductId < rightMerchantProductId
      ? leftMerchantProductId
      : rightMerchantProductId,
    leftMerchantProductId < rightMerchantProductId
      ? rightMerchantProductId
      : leftMerchantProductId
  );
  return graph.unsurePairKeys.has(pairKey);
}

function relationshipCorruptMerchantProductIds(
  graph: PersonalDecisionGraph,
  leftMerchantProductId: string,
  rightMerchantProductId: string
): string[] {
  const corrupt = new Set<string>();
  if (graph.corruptMerchantProductIds.has(leftMerchantProductId)) {
    corrupt.add(leftMerchantProductId);
  }
  if (graph.corruptMerchantProductIds.has(rightMerchantProductId)) {
    corrupt.add(rightMerchantProductId);
  }
  return [...corrupt].sort();
}

export function evaluatePersonalRelationship(
  graph: PersonalDecisionGraph,
  leftMerchantProductId: string,
  rightMerchantProductId: string
): PersonalRelationshipEvaluation {
  const corruptIds = relationshipCorruptMerchantProductIds(
    graph,
    leftMerchantProductId,
    rightMerchantProductId
  );
  if (corruptIds.length > 0) {
    return {
      kind: 'corrupt',
      corruptMerchantProductIds: corruptIds,
    };
  }

  if (
    hasActiveNegativeConstraint(graph, leftMerchantProductId, rightMerchantProductId)
  ) {
    return {
      kind: 'negative_veto',
      leftMerchantProductId,
      rightMerchantProductId,
    };
  }

  if (areInSamePersonalComponent(graph, leftMerchantProductId, rightMerchantProductId)) {
    const authority =
      derivePersonalExactAuthority(graph, leftMerchantProductId) ??
      derivePersonalExactAuthority(graph, rightMerchantProductId);
    if (authority) {
      return { kind: 'same_component', authority };
    }
  }

  if (
    shouldSuppressPersonalIdentityPrompt(
      graph,
      leftMerchantProductId,
      rightMerchantProductId
    )
  ) {
    return { kind: 'unsure_suppressed' };
  }

  return { kind: 'none' };
}

export function evaluatePersonalRelationshipWithSnapshot(
  rows: readonly StoredPersonalProductIdentityDecision[],
  snapshot: PersonalProductCurrentEndpointSnapshot,
  leftMerchantProductId: string,
  rightMerchantProductId: string,
  options?: { requiredIds?: readonly string[] }
): PersonalRelationshipEvaluation {
  const requiredIds =
    options?.requiredIds ??
    collectOwnerGraphMerchantProductIds(rows, [
      leftMerchantProductId,
      rightMerchantProductId,
    ]);
  const snapshotValidation = validateCurrentEndpointSnapshot(requiredIds, snapshot);
  if (!snapshotValidation.ok) {
    return {
      kind: 'context_incomplete',
      missingMerchantProductIds: snapshotValidation.missingMerchantProductIds,
    };
  }

  const graphResult = buildPersonalDecisionGraph(rows, snapshot, { requiredIds });
  if (!graphResult.ok) {
    return {
      kind: 'context_incomplete',
      missingMerchantProductIds: graphResult.missingMerchantProductIds,
    };
  }

  return evaluatePersonalRelationship(
    graphResult.graph,
    leftMerchantProductId,
    rightMerchantProductId
  );
}

export type RecordPersonalDecisionPrecheck =
  | { ok: true; outcome: 'create' | 'idempotent' }
  | {
      ok: false;
      code:
        | 'personal_not_same_conflict'
        | 'personal_same_component_conflict'
        | 'decision_conflict';
      existingDecision?: PersonalProductIdentityDecision;
    };

export function precheckPersonalDecisionWrite(
  graph: PersonalDecisionGraph,
  existingDecision: PersonalProductIdentityDecision | null,
  requestedDecision: PersonalProductIdentityDecision,
  leftMerchantProductId: string,
  rightMerchantProductId: string
): RecordPersonalDecisionPrecheck {
  if (existingDecision === requestedDecision) {
    if (existingDecision) {
      return { ok: true, outcome: 'idempotent' };
    }
  }

  if (requestedDecision === 'same_product') {
    if (
      hasActiveNegativeConstraint(graph, leftMerchantProductId, rightMerchantProductId)
    ) {
      return {
        ok: false,
        code: 'personal_not_same_conflict',
        existingDecision: existingDecision ?? undefined,
      };
    }
    if (
      areInSamePersonalComponent(graph, leftMerchantProductId, rightMerchantProductId)
    ) {
      if (!existingDecision) {
        return { ok: true, outcome: 'idempotent' };
      }
      return {
        ok: false,
        code: 'decision_conflict',
        existingDecision,
      };
    }
    if (existingDecision && existingDecision !== requestedDecision) {
      return {
        ok: false,
        code: 'decision_conflict',
        existingDecision,
      };
    }
    return { ok: true, outcome: 'create' };
  }

  if (requestedDecision === 'not_same_product') {
    if (
      areInSamePersonalComponent(graph, leftMerchantProductId, rightMerchantProductId)
    ) {
      return {
        ok: false,
        code: 'personal_same_component_conflict',
        existingDecision: existingDecision ?? undefined,
      };
    }
    if (
      hasActiveNegativeConstraint(graph, leftMerchantProductId, rightMerchantProductId)
    ) {
      if (!existingDecision) {
        return { ok: true, outcome: 'idempotent' };
      }
      return {
        ok: false,
        code: 'decision_conflict',
        existingDecision,
      };
    }
    if (existingDecision && existingDecision !== requestedDecision) {
      return {
        ok: false,
        code: 'decision_conflict',
        existingDecision,
      };
    }
    return { ok: true, outcome: 'create' };
  }

  if (existingDecision && existingDecision !== requestedDecision) {
    return {
      ok: false,
      code: 'decision_conflict',
      existingDecision,
    };
  }

  return { ok: true, outcome: 'create' };
}
