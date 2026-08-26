/**
 * B1 / B1.1 / B1.1.1 — Knowledge & Memory Contract (read-only foundation).
 *
 * Architecture ladder (consumers must not skip evidence steps):
 *
 *   Receipt Observation
 *     → Product Identity
 *       → Purchase Memory
 *         → Pattern
 *           → Prediction
 *             → Action Candidate
 *
 * ClaimEligibility = “may this memory/pattern claim be expressed?”
 * It NEVER substitutes A1.2 exact-price / cycle-prediction / action gates.
 *
 * ValidatedProductKnowledgeQuery brand is a compile-time composition guard.
 * Untrusted runtime JSON must still pass validateProductKnowledgeQuery.
 * Deliberate `as any` can bypass TS — that is out of contract scope.
 */

import type {
  ProductAttributes,
  ProductIdentityLevel,
} from '../productIdentityContract';
import { PRODUCT_IDENTITY_LEVELS } from '../productIdentityContract';

export const KNOWLEDGE_MEMORY_CONTRACT_VERSION =
  'meruno-knowledge-memory-contract-b1.1.2-v1' as const;

// ---------------------------------------------------------------------------
// Knowledge scope / source tier
// ---------------------------------------------------------------------------

export type KnowledgeScope =
  | 'personal'
  | 'global_candidate'
  | 'global_verified';

export type KnowledgeSourceTier =
  | 'personal_manual'
  | 'global_verified'
  | 'merchant_knowledge'
  | 'local_rule'
  | 'ai'
  | 'unresolved';

const KNOWLEDGE_SCOPES: readonly KnowledgeScope[] = [
  'personal',
  'global_candidate',
  'global_verified',
];

const KNOWLEDGE_SOURCE_TIERS: readonly KnowledgeSourceTier[] = [
  'personal_manual',
  'global_verified',
  'merchant_knowledge',
  'local_rule',
  'ai',
  'unresolved',
];

const ALLOWED_SCOPE_TIER: Record<KnowledgeScope, readonly KnowledgeSourceTier[]> =
  {
    personal: [
      'personal_manual',
      'merchant_knowledge',
      'local_rule',
      'ai',
      'unresolved',
    ],
    global_candidate: [
      'merchant_knowledge',
      'local_rule',
      'ai',
      'unresolved',
    ],
    global_verified: ['global_verified'],
  };

const SOURCE_TIER_PRIORITY: Record<KnowledgeSourceTier, number> = {
  personal_manual: 0,
  global_verified: 1,
  merchant_knowledge: 2,
  local_rule: 3,
  ai: 4,
  unresolved: 5,
};

export function knowledgeSourcePriority(tier: KnowledgeSourceTier): number {
  return SOURCE_TIER_PRIORITY[tier];
}

export function compareKnowledgeSources(
  a: KnowledgeSourceTier,
  b: KnowledgeSourceTier
): number {
  return knowledgeSourcePriority(a) - knowledgeSourcePriority(b);
}

export function isKnowledgeScope(value: unknown): value is KnowledgeScope {
  return (
    typeof value === 'string' &&
    (KNOWLEDGE_SCOPES as readonly string[]).includes(value)
  );
}

export function isKnowledgeSourceTier(
  value: unknown
): value is KnowledgeSourceTier {
  return (
    typeof value === 'string' &&
    (KNOWLEDGE_SOURCE_TIERS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Privacy kinds (defined early — enforced inside validateKnowledgeRecord)
// ---------------------------------------------------------------------------

export const GLOBAL_SHAREABLE_KNOWLEDGE_KINDS = [
  'product_alias',
  'product_identity',
  'product_spec',
  'product_category',
  'merchant_alias',
  'receipt_parse_rule',
  'ocr_correction',
] as const;

export type GlobalShareableKnowledgeKind =
  (typeof GLOBAL_SHAREABLE_KNOWLEDGE_KINDS)[number];

export const PERSONAL_BEHAVIORAL_KNOWLEDGE_KINDS = [
  'purchase_history',
  'purchase_frequency',
  'purchase_cycle',
  'personal_price_history',
  'merchant_preference',
] as const;

export type PersonalBehavioralKnowledgeKind =
  (typeof PERSONAL_BEHAVIORAL_KNOWLEDGE_KINDS)[number];

/**
 * Privacy / knowledge semantic class.
 * Distinct from claimKey (grouping key for one semantic claim).
 * Do NOT require claimKey === knowledgeKind.
 */
export type KnowledgeKind =
  | GlobalShareableKnowledgeKind
  | PersonalBehavioralKnowledgeKind;

export function isGlobalShareableKnowledgeKind(
  kind: unknown
): kind is GlobalShareableKnowledgeKind {
  return (
    typeof kind === 'string' &&
    (GLOBAL_SHAREABLE_KNOWLEDGE_KINDS as readonly string[]).includes(kind)
  );
}

export function isPersonalBehavioralKnowledgeKind(
  kind: unknown
): kind is PersonalBehavioralKnowledgeKind {
  return (
    typeof kind === 'string' &&
    (PERSONAL_BEHAVIORAL_KNOWLEDGE_KINDS as readonly string[]).includes(kind)
  );
}

export function isKnowledgeKind(kind: unknown): kind is KnowledgeKind {
  return (
    isGlobalShareableKnowledgeKind(kind) ||
    isPersonalBehavioralKnowledgeKind(kind)
  );
}

export type ClaimEligibilityStatus =
  | 'eligible'
  | 'eligible_with_caution'
  | 'insufficient_evidence'
  | 'conflicting_evidence';

export type ClaimEligibility = {
  status: ClaimEligibilityStatus;
  reasonCodes: string[];
};

export function claimEligibility(
  status: ClaimEligibilityStatus,
  reasonCodes: readonly string[] = []
): ClaimEligibility {
  return { status, reasonCodes: stableUnique([...reasonCodes]) };
}

/**
 * Fail-closed privacy boundary.
 * NOT PERSONAL ≠ GLOBAL SHAREABLE.
 * Only GlobalShareableKnowledgeKind may use global_candidate / global_verified.
 */
export function evaluateKnowledgeScopeEligibility(input: {
  kind: unknown;
  scope: unknown;
}): ClaimEligibility {
  if (!isKnowledgeScope(input.scope)) {
    return claimEligibility('insufficient_evidence', [
      'unknown_or_invalid_scope',
    ]);
  }
  const scope = input.scope;
  const isPersonal = isPersonalBehavioralKnowledgeKind(input.kind);
  const isGlobalShareable = isGlobalShareableKnowledgeKind(input.kind);

  if (!isPersonal && !isGlobalShareable) {
    return claimEligibility('insufficient_evidence', [
      'unknown_knowledge_kind',
      `kind=${String(input.kind)}`,
    ]);
  }

  if (isPersonal) {
    if (scope !== 'personal') {
      return claimEligibility('conflicting_evidence', [
        'personal_behavioral_must_remain_personal',
        `kind=${String(input.kind)}`,
        `scope=${scope}`,
      ]);
    }
    return claimEligibility('eligible', [
      'personal_behavioral_scope_ok',
      `kind=${String(input.kind)}`,
    ]);
  }

  if (scope === 'global_candidate' || scope === 'global_verified') {
    return claimEligibility('eligible', [
      'global_shareable_kind_ok',
      `kind=${String(input.kind)}`,
      `scope=${scope}`,
    ]);
  }
  return claimEligibility('eligible', [
    'personal_scope_for_shareable_kind_ok',
    `kind=${String(input.kind)}`,
  ]);
}

export function scopeForPersonalManualCorrection(): KnowledgeScope {
  return 'personal';
}

// ---------------------------------------------------------------------------
// Runtime structural helpers
// ---------------------------------------------------------------------------

export type KnowledgeRecordValidation = {
  ok: boolean;
  reasonCodes: string[];
};

function isValidConfidence(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

function requireNonEmptyTrimmedString(
  value: unknown,
  code: string,
  reasonCodes: string[]
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    reasonCodes.push(code);
    return null;
  }
  return value.trim();
}

/**
 * evidence / reasonCodes: Array of non-empty strings after trim.
 * Returns canonical sorted+deduped list, or null if structurally invalid.
 */
function canonicalizeStringArray(
  value: unknown,
  fieldCode: string,
  reasonCodes: string[]
): string[] | null {
  if (!Array.isArray(value)) {
    reasonCodes.push(`${fieldCode}_not_array`);
    return null;
  }
  const out: string[] = [];
  for (const el of value) {
    if (typeof el !== 'string') {
      reasonCodes.push(`${fieldCode}_entry_not_string`);
      return null;
    }
    const t = el.trim();
    if (t === '') {
      reasonCodes.push(`${fieldCode}_entry_blank`);
      return null;
    }
    out.push(t);
  }
  return stableUnique(out);
}

/**
 * Fail-closed runtime validator for KnowledgeCandidate / ProductKnowledgeRecord.
 * Enforces structure + scope/tier + privacy(knowledgeKind, scope) + confidence + evidence.
 * Consumers must not call privacy separately — it is integrated here.
 */
export function validateKnowledgeRecord(input: unknown): KnowledgeRecordValidation {
  const reasonCodes: string[] = [];
  if (input == null || typeof input !== 'object') {
    return { ok: false, reasonCodes: ['invalid_knowledge_record'] };
  }
  const rec = input as Record<string, unknown>;

  if (requireNonEmptyTrimmedString(rec.id, 'invalid_record_id', reasonCodes) == null) {
    return { ok: false, reasonCodes };
  }

  if (!isKnowledgeKind(rec.knowledgeKind)) {
    reasonCodes.push('unknown_knowledge_kind');
    reasonCodes.push(`kind=${String(rec.knowledgeKind)}`);
    return { ok: false, reasonCodes };
  }

  if (!isKnowledgeScope(rec.scope)) {
    reasonCodes.push('unknown_or_invalid_scope');
    return { ok: false, reasonCodes };
  }
  if (!isKnowledgeSourceTier(rec.sourceTier)) {
    reasonCodes.push('unknown_or_invalid_source_tier');
    return { ok: false, reasonCodes };
  }

  const scope = rec.scope;
  const tier = rec.sourceTier;
  const kind = rec.knowledgeKind;

  // Privacy integrated into record validation (main selection path).
  const privacy = evaluateKnowledgeScopeEligibility({ kind, scope });
  if (
    privacy.status === 'insufficient_evidence' ||
    privacy.status === 'conflicting_evidence'
  ) {
    reasonCodes.push('privacy_validation_failed');
    reasonCodes.push(...privacy.reasonCodes);
    return { ok: false, reasonCodes };
  }

  if (!ALLOWED_SCOPE_TIER[scope].includes(tier)) {
    reasonCodes.push('invalid_scope_source_tier_combination');
    reasonCodes.push(`scope=${scope}`);
    reasonCodes.push(`sourceTier=${tier}`);
    if (scope === 'global_candidate' && tier === 'global_verified') {
      reasonCodes.push('global_candidate_cannot_use_global_verified_tier');
    }
    if (scope === 'global_candidate' && tier === 'personal_manual') {
      reasonCodes.push('global_candidate_cannot_use_personal_manual_tier');
    }
    if (tier === 'personal_manual' && scope !== 'personal') {
      reasonCodes.push('personal_manual_requires_personal_scope');
    }
    return { ok: false, reasonCodes };
  }

  if (!isValidConfidence(rec.confidence)) {
    reasonCodes.push('invalid_confidence');
    return { ok: false, reasonCodes };
  }

  const evidence = canonicalizeStringArray(rec.evidence, 'evidence', reasonCodes);
  if (evidence == null) {
    return { ok: false, reasonCodes };
  }
  if (scope === 'global_verified' && evidence.length === 0) {
    reasonCodes.push('global_verified_requires_non_empty_evidence');
    return { ok: false, reasonCodes };
  }

  if ('reasonCodes' in rec && rec.reasonCodes !== undefined) {
    const rc = canonicalizeStringArray(rec.reasonCodes, 'reasonCodes', reasonCodes);
    if (rc == null) return { ok: false, reasonCodes };
  }

  if ('providerId' in rec && rec.providerId !== undefined && rec.providerId !== null) {
    if (
      requireNonEmptyTrimmedString(rec.providerId, 'invalid_provider_id', reasonCodes) ==
      null
    ) {
      return { ok: false, reasonCodes };
    }
  }

  // Selection candidates always carry claimKey; provider records may omit it.
  if ('claimKey' in rec || 'claimValue' in rec) {
    if (
      requireNonEmptyTrimmedString(rec.claimKey, 'invalid_claim_key', reasonCodes) ==
      null
    ) {
      return { ok: false, reasonCodes };
    }
  }

  // Provider records require providerId.
  if (!('claimValue' in rec) && !('claimKey' in rec)) {
    if (
      requireNonEmptyTrimmedString(rec.providerId, 'invalid_provider_id', reasonCodes) ==
      null
    ) {
      return { ok: false, reasonCodes };
    }
  }

  return { ok: true, reasonCodes: ['knowledge_record_valid'] };
}

export function canonicalSerialize(value: unknown): string {
  return canonicalSerializeInner(value);
}

function canonicalSerializeInner(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `num:${String(value)}`;
    return `num:${value}`;
  }
  if (typeof value === 'boolean') return `bool:${value}`;
  if (typeof value === 'string') return `str:${JSON.stringify(value)}`;
  if (Array.isArray(value)) {
    // String arrays: canonicalize order for fingerprint equality.
    if (value.every((v) => typeof v === 'string')) {
      const canon = stableUnique(value.map((v) => (v as string).trim()).filter(Boolean));
      return `[${canon.map(canonicalSerializeInner).join(',')}]`;
    }
    return `[${value.map(canonicalSerializeInner).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(strcmp);
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalSerializeInner(obj[k])}`)
      .join(',')}}`;
  }
  return `other:${String(value)}`;
}

export function semanticValuesEqual(a: unknown, b: unknown): boolean {
  return canonicalSerialize(a) === canonicalSerialize(b);
}

// ---------------------------------------------------------------------------
// Knowledge selection
// ---------------------------------------------------------------------------

export type KnowledgeCandidate = {
  id: string;
  providerId?: string;
  /** Privacy class — required; not interchangeable with claimKey. */
  knowledgeKind: KnowledgeKind;
  scope: KnowledgeScope;
  sourceTier: KnowledgeSourceTier;
  /** Semantic claim grouping key (may differ from knowledgeKind). */
  claimKey: string;
  claimValue: unknown;
  confidence: number;
  evidence: readonly string[];
  reasonCodes?: readonly string[];
};

export type KnowledgeConflict = {
  claimKey: string;
  leftId: string;
  rightId: string;
  leftFingerprint: string;
  rightFingerprint: string;
};

export type KnowledgeSelectionStatus =
  | 'selected'
  | 'selected_with_conflict'
  | 'candidate_only'
  | 'no_match'
  | 'invalid_input';

/**
 * Explicit authority provenance for the selected winner.
 *
 * authority provenance ≠ absence of conflict.
 * A result may be authorityKind='global_verified' AND status='selected_with_conflict'.
 * Consumers must not ignore conflicts because provenance looks strong.
 */
export type KnowledgeAuthorityKind =
  | 'personal_manual'
  | 'global_verified'
  | 'local_preferred'
  | 'candidate_only'
  | 'none';

export type KnowledgeSelectionResult = {
  status: KnowledgeSelectionStatus;
  selected: KnowledgeCandidate | null;
  authorityKind: KnowledgeAuthorityKind;
  conflicts: KnowledgeConflict[];
  reasonCodes: string[];
};

/** Internal only — call after validateKnowledgeRecord(c).ok. Not exported. */
function resolveAuthorityKind(
  c: KnowledgeCandidate | null
): KnowledgeAuthorityKind {
  if (c == null) return 'none';
  if (c.scope === 'global_candidate') return 'candidate_only';
  if (c.scope === 'global_verified' && c.sourceTier === 'global_verified') {
    return 'global_verified';
  }
  if (c.scope === 'personal' && c.sourceTier === 'personal_manual') {
    return 'personal_manual';
  }
  if (c.scope === 'personal') return 'local_preferred';
  return 'none';
}

const AUTHORITY_RANK: Record<KnowledgeAuthorityKind, number> = {
  personal_manual: 0,
  global_verified: 1,
  local_preferred: 2,
  candidate_only: 3,
  none: 4,
};

export function isGloballyVerifiedSelection(
  result: KnowledgeSelectionResult
): boolean {
  return result.authorityKind === 'global_verified';
}

export function isPersonalManualSelection(
  result: KnowledgeSelectionResult
): boolean {
  return result.authorityKind === 'personal_manual';
}

export function isUsableKnowledgeSelection(
  result: KnowledgeSelectionResult
): boolean {
  return (
    result.selected != null &&
    (result.status === 'selected' ||
      result.status === 'selected_with_conflict' ||
      result.status === 'candidate_only')
  );
}

function candidateFingerprint(c: KnowledgeCandidate): string {
  const evidence = canonicalizeStringArray(c.evidence, 'evidence', []) ?? [];
  const reasonCodes =
    c.reasonCodes != null
      ? canonicalizeStringArray(c.reasonCodes, 'reasonCodes', []) ?? []
      : [];
  return canonicalSerialize({
    id: c.id,
    providerId: c.providerId ?? '',
    knowledgeKind: c.knowledgeKind,
    scope: c.scope,
    sourceTier: c.sourceTier,
    claimKey: c.claimKey,
    claimValue: c.claimValue,
    confidence: c.confidence,
    evidence,
    reasonCodes,
  });
}

function semanticFingerprint(c: KnowledgeCandidate): string {
  return canonicalSerialize(c.claimValue);
}

/** Orient conflict pair by fingerprint so reverse input yields identical metadata. */
function makeConflict(
  a: KnowledgeCandidate,
  b: KnowledgeCandidate
): KnowledgeConflict {
  const fa = semanticFingerprint(a);
  const fb = semanticFingerprint(b);
  let left = a;
  let right = b;
  let leftFp = fa;
  let rightFp = fb;
  if (fa > fb || (fa === fb && candidateFingerprint(a) > candidateFingerprint(b))) {
    left = b;
    right = a;
    leftFp = fb;
    rightFp = fa;
  }
  return {
    claimKey: a.claimKey,
    leftId: left.id,
    rightId: right.id,
    leftFingerprint: leftFp,
    rightFingerprint: rightFp,
  };
}

function sortConflicts(conflicts: KnowledgeConflict[]): KnowledgeConflict[] {
  return [...conflicts].sort((a, b) => {
    const k = strcmp(a.claimKey, b.claimKey);
    if (k !== 0) return k;
    const l = strcmp(a.leftFingerprint, b.leftFingerprint);
    if (l !== 0) return l;
    const r = strcmp(a.rightFingerprint, b.rightFingerprint);
    if (r !== 0) return r;
    const li = strcmp(a.leftId, b.leftId);
    if (li !== 0) return li;
    return strcmp(a.rightId, b.rightId);
  });
}

export function selectBestKnowledgeCandidate(
  candidates: readonly KnowledgeCandidate[]
): KnowledgeSelectionResult {
  const reasonCodes: string[] = [];

  if (candidates.length === 0) {
    return {
      status: 'no_match',
      selected: null,
      authorityKind: 'none',
      conflicts: [],
      reasonCodes: ['no_candidates'],
    };
  }

  const claimKeys = [
    ...new Set(
      candidates.map((c) =>
        typeof c.claimKey === 'string' ? c.claimKey.trim() : ''
      )
    ),
  ].sort(strcmp);
  if (claimKeys.length !== 1 || claimKeys[0] === '') {
    return {
      status: 'invalid_input',
      selected: null,
      authorityKind: 'none',
      conflicts: [],
      reasonCodes: stableUnique([
        'mixed_claim_keys',
        ...claimKeys.map((k) => `claimKey=${k || '<empty>'}`),
      ]),
    };
  }

  const valid: KnowledgeCandidate[] = [];
  for (const c of candidates) {
    const v = validateKnowledgeRecord(c);
    if (!v.ok) {
      const idLabel = typeof c.id === 'string' ? c.id : '<missing-id>';
      reasonCodes.push(...v.reasonCodes.map((r) => `rejected:${idLabel}:${r}`));
      continue;
    }
    valid.push(c);
  }

  if (valid.length === 0) {
    return {
      status: 'no_match',
      selected: null,
      authorityKind: 'none',
      conflicts: [],
      reasonCodes: stableUnique([...reasonCodes, 'no_valid_candidates']),
    };
  }

  const byId = new Map<string, KnowledgeCandidate[]>();
  for (const c of valid) {
    const list = byId.get(c.id) ?? [];
    list.push(c);
    byId.set(c.id, list);
  }

  const conflicts: KnowledgeConflict[] = [];
  const deduped: KnowledgeCandidate[] = [];
  for (const id of [...byId.keys()].sort(strcmp)) {
    const group = byId.get(id)!;
    const fps = new Map<string, KnowledgeCandidate>();
    for (const c of group) fps.set(candidateFingerprint(c), c);
    if (fps.size > 1) {
      const variants = [...fps.values()].sort((a, b) =>
        strcmp(candidateFingerprint(a), candidateFingerprint(b))
      );
      reasonCodes.push('duplicate_id_differing_content');
      for (let i = 0; i < variants.length; i++) {
        for (let j = i + 1; j < variants.length; j++) {
          conflicts.push(makeConflict(variants[i]!, variants[j]!));
        }
      }
      return {
        status: 'invalid_input',
        selected: null,
        authorityKind: 'none',
        conflicts: sortConflicts(conflicts),
        reasonCodes: stableUnique([...reasonCodes, 'duplicate_id_conflict']),
      };
    }
    if (group.length > 1) reasonCodes.push('exact_duplicate_deduped');
    deduped.push([...fps.values()][0]!);
  }

  const active = deduped.filter((c) => c.sourceTier !== 'unresolved');
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      if (!semanticValuesEqual(a.claimValue, b.claimValue)) {
        conflicts.push(makeConflict(a, b));
      }
    }
  }

  const ranked = [...deduped].sort((a, b) => {
    const ar = AUTHORITY_RANK[resolveAuthorityKind(a)];
    const br = AUTHORITY_RANK[resolveAuthorityKind(b)];
    if (ar !== br) return ar - br;
    const p = compareKnowledgeSources(a.sourceTier, b.sourceTier);
    if (p !== 0) return p;
    if (a.confidence !== b.confidence) {
      return a.confidence > b.confidence ? -1 : 1;
    }
    const fs = strcmp(semanticFingerprint(a), semanticFingerprint(b));
    if (fs !== 0) return fs;
    const idCmp = strcmp(a.id, b.id);
    if (idCmp !== 0) return idCmp;
    return strcmp(a.providerId ?? '', b.providerId ?? '');
  });

  const winner = ranked[0]!;
  const authorityKind = resolveAuthorityKind(winner);

  let status: KnowledgeSelectionStatus;
  if (winner.scope === 'global_candidate') {
    status =
      conflicts.length > 0 ? 'selected_with_conflict' : 'candidate_only';
    reasonCodes.push('global_candidate_not_verified_authority');
  } else if (conflicts.length > 0) {
    status = 'selected_with_conflict';
    reasonCodes.push('semantic_conflict_retained');
  } else {
    status = 'selected';
  }

  reasonCodes.push(`selected_id=${winner.id}`);
  reasonCodes.push(`selected_source=${winner.sourceTier}`);
  reasonCodes.push(`authorityKind=${authorityKind}`);

  return {
    status,
    selected: winner,
    authorityKind,
    conflicts: sortConflicts(conflicts),
    reasonCodes: stableUnique(reasonCodes),
  };
}

// ---------------------------------------------------------------------------
// Product knowledge provider seam
// ---------------------------------------------------------------------------

type AtLeastOne<T> = {
  [K in keyof T]-?: Required<Pick<T, K>> &
    Partial<Pick<T, Exclude<keyof T, K>>>;
}[keyof T];

export type ProductKnowledgeQueryFields = {
  merchantKey?: string;
  normalizedName?: string;
  comparisonKey?: string;
  janCode?: string;
  skuId?: string;
};

/**
 * At least one discriminator required at the type level ({} is a TS error).
 * WHEN MULTIPLE DISCRIMINATORS ARE PROVIDED: AND semantics (not OR).
 */
export type ProductKnowledgeQuery = AtLeastOne<ProductKnowledgeQueryFields>;

declare const VALIDATED_PRODUCT_KNOWLEDGE_QUERY: unique symbol;

/**
 * Compile-time validated query brand (immutable discriminators).
 * Runtime untrusted input must still pass validateProductKnowledgeQuery.
 * Success returns a new normalized object — not the caller's reference — and
 * Object.freeze() is applied (shallow; string fields only).
 */
export type ValidatedProductKnowledgeQuery = Readonly<
  ProductKnowledgeQuery & {
    readonly [VALIDATED_PRODUCT_KNOWLEDGE_QUERY]: true;
  }
>;

export type ValidateProductKnowledgeQueryResult =
  | {
      ok: true;
      query: ValidatedProductKnowledgeQuery;
      reasonCodes: string[];
      discriminators: string[];
    }
  | {
      ok: false;
      query: null;
      reasonCodes: string[];
      discriminators: string[];
    };

const QUERY_DISCRIMINATORS = [
  'merchantKey',
  'normalizedName',
  'comparisonKey',
  'janCode',
  'skuId',
] as const;

type QueryDiscriminatorKey = (typeof QUERY_DISCRIMINATORS)[number];

function isQueryDiscriminatorAbsent(
  q: Record<string, unknown>,
  key: QueryDiscriminatorKey
): boolean {
  return !(key in q) || q[key] === undefined;
}

/**
 * Missing discriminator = OK. Present but malformed = entire query invalid.
 * Malformed values must not be silently dropped (AND semantics require all
 * supplied fields to be valid).
 */
function parseSuppliedQueryDiscriminator(
  q: Record<string, unknown>,
  key: QueryDiscriminatorKey
):
  | { kind: 'absent' }
  | { kind: 'valid'; value: string }
  | { kind: 'malformed' } {
  if (isQueryDiscriminatorAbsent(q, key)) {
    return { kind: 'absent' };
  }
  const raw = q[key];
  if (typeof raw !== 'string') {
    return { kind: 'malformed' };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { kind: 'malformed' };
  }
  return { kind: 'valid', value: trimmed };
}

export function validateProductKnowledgeQuery(
  query: unknown
): ValidateProductKnowledgeQueryResult {
  if (query == null || typeof query !== 'object' || Array.isArray(query)) {
    return {
      ok: false,
      query: null,
      reasonCodes: ['invalid_query'],
      discriminators: [],
    };
  }
  const q = query as Record<string, unknown>;
  const fields: Partial<Record<QueryDiscriminatorKey, string>> = {};
  const present: QueryDiscriminatorKey[] = [];

  for (const key of QUERY_DISCRIMINATORS) {
    const parsed = parseSuppliedQueryDiscriminator(q, key);
    if (parsed.kind === 'malformed') {
      return {
        ok: false,
        query: null,
        reasonCodes: ['invalid_query', `malformed_discriminator=${key}`],
        discriminators: [],
      };
    }
    if (parsed.kind === 'valid') {
      fields[key] = parsed.value;
      present.push(key);
    }
  }

  if (present.length === 0) {
    return {
      ok: false,
      query: null,
      reasonCodes: ['invalid_query', 'missing_discriminator'],
      discriminators: [],
    };
  }

  const validated = Object.freeze({
    ...fields,
  }) as ValidatedProductKnowledgeQuery;

  return {
    ok: true,
    query: validated,
    reasonCodes: [
      'query_ok',
      'query_semantics=AND',
      ...present.map((d) => `disc=${d}`),
    ],
    discriminators: [...present].sort(strcmp),
  };
}

export type ProductKnowledgeRecord = {
  id: string;
  providerId: string;
  knowledgeKind: KnowledgeKind;
  scope: KnowledgeScope;
  sourceTier: KnowledgeSourceTier;
  /** Optional claim grouping when comparing alternatives. */
  claimKey?: string;
  canonicalName?: string | null;
  category?: string | null;
  brand?: string | null;
  attributes?: ProductAttributes | null;
  merchantProductId?: string | null;
  canonicalProductId?: string | null;
  skuId?: string | null;
  identityLevel?: ProductIdentityLevel | null;
  confidence: number;
  evidence: readonly string[];
  reasonCodes: readonly string[];
};

export type ProductKnowledgeLookupStatus =
  | 'matched'
  | 'no_match'
  | 'unresolved'
  | 'conflict'
  | 'invalid_query';

export type ProductKnowledgeLookupResult = {
  status: ProductKnowledgeLookupStatus;
  records: readonly ProductKnowledgeRecord[];
  reasonCodes: readonly string[];
};

/**
 * Provider receives only ValidatedProductKnowledgeQuery.
 * Prefer normalizing returned records via normalizeProductKnowledgeLookupResult.
 * No network / Supabase in B1.1.1.
 */
export interface ProductKnowledgeProvider {
  readonly providerId: string;
  readonly defaultScope: KnowledgeScope;
  /**
   * Sync read in B1.1.1. Future network providers may wrap async behind an
   * adapter; the validated-query boundary remains the same.
   */
  lookup(query: ValidatedProductKnowledgeQuery): ProductKnowledgeLookupResult;
}

function recordFingerprint(r: ProductKnowledgeRecord): string {
  const evidence = canonicalizeStringArray(r.evidence, 'evidence', []) ?? [];
  const reasonCodes =
    canonicalizeStringArray(r.reasonCodes, 'reasonCodes', []) ?? [];
  return canonicalSerialize({
    id: r.id,
    providerId: r.providerId,
    knowledgeKind: r.knowledgeKind,
    scope: r.scope,
    sourceTier: r.sourceTier,
    claimKey: r.claimKey ?? '',
    canonicalName: r.canonicalName ?? null,
    category: r.category ?? null,
    brand: r.brand ?? null,
    attributes: r.attributes ?? null,
    merchantProductId: r.merchantProductId ?? null,
    canonicalProductId: r.canonicalProductId ?? null,
    skuId: r.skuId ?? null,
    identityLevel: r.identityLevel ?? null,
    confidence: r.confidence,
    evidence,
    reasonCodes,
  });
}

function recordSemanticFingerprint(r: ProductKnowledgeRecord): string {
  return canonicalSerialize({
    knowledgeKind: r.knowledgeKind,
    claimKey: r.claimKey ?? '',
    canonicalName: r.canonicalName ?? null,
    category: r.category ?? null,
    brand: r.brand ?? null,
    attributes: r.attributes ?? null,
    merchantProductId: r.merchantProductId ?? null,
    canonicalProductId: r.canonicalProductId ?? null,
    skuId: r.skuId ?? null,
    identityLevel: r.identityLevel ?? null,
  });
}

/**
 * Normalize provider output.
 *
 * status:
 * - no_match: zero valid records
 * - unresolved: only unresolved-tier records
 * - matched: ≥1 resolved usable record, no semantic conflict
 * - conflict: duplicate-id differing content OR resolved claimKey disagreement
 */
export function normalizeProductKnowledgeLookupResult(
  records: readonly ProductKnowledgeRecord[]
): ProductKnowledgeLookupResult {
  const reasonCodes: string[] = [];
  const valid: ProductKnowledgeRecord[] = [];

  for (const r of records) {
    const v = validateKnowledgeRecord(r);
    if (!v.ok) {
      const idLabel = typeof r?.id === 'string' ? r.id : '<missing-id>';
      reasonCodes.push(...v.reasonCodes.map((c) => `rejected:${idLabel}:${c}`));
      continue;
    }
    valid.push(r);
  }

  const byId = new Map<string, ProductKnowledgeRecord[]>();
  for (const r of valid) {
    const list = byId.get(r.id) ?? [];
    list.push(r);
    byId.set(r.id, list);
  }

  const out: ProductKnowledgeRecord[] = [];
  for (const id of [...byId.keys()].sort(strcmp)) {
    const group = byId.get(id)!;
    const fps = new Map<string, ProductKnowledgeRecord>();
    for (const r of group) fps.set(recordFingerprint(r), r);
    if (fps.size > 1) {
      return {
        status: 'conflict',
        records: [],
        reasonCodes: stableUnique([
          ...reasonCodes,
          'duplicate_id_differing_content',
          `id=${id}`,
        ]),
      };
    }
    if (group.length > 1) reasonCodes.push('exact_duplicate_deduped');
    out.push([...fps.values()][0]!);
  }

  out.sort((a, b) => {
    const p = compareKnowledgeSources(a.sourceTier, b.sourceTier);
    if (p !== 0) return p;
    if (a.confidence !== b.confidence) {
      return a.confidence > b.confidence ? -1 : 1;
    }
    const f = strcmp(recordFingerprint(a), recordFingerprint(b));
    if (f !== 0) return f;
    const id = strcmp(a.id, b.id);
    if (id !== 0) return id;
    return strcmp(a.providerId, b.providerId);
  });

  if (out.length === 0) {
    return {
      status: 'no_match',
      records: [],
      reasonCodes: stableUnique([...reasonCodes, 'no_valid_records']),
    };
  }

  const resolved = out.filter((r) => r.sourceTier !== 'unresolved');
  if (resolved.length === 0) {
    return {
      status: 'unresolved',
      records: out,
      reasonCodes: stableUnique([...reasonCodes, 'only_unresolved_records']),
    };
  }

  // Resolved claimKey disagreement → conflict.
  const byClaim = new Map<string, ProductKnowledgeRecord[]>();
  for (const r of resolved) {
    const key =
      typeof r.claimKey === 'string' && r.claimKey.trim() !== ''
        ? r.claimKey.trim()
        : `__id:${r.id}`;
    const list = byClaim.get(key) ?? [];
    list.push(r);
    byClaim.set(key, list);
  }
  for (const key of [...byClaim.keys()].sort(strcmp)) {
    const group = byClaim.get(key)!;
    if (group.length < 2) continue;
    const sem = new Set(group.map(recordSemanticFingerprint));
    if (sem.size > 1) {
      return {
        status: 'conflict',
        records: out,
        reasonCodes: stableUnique([
          ...reasonCodes,
          'resolved_semantic_conflict',
          `claimKey=${key}`,
        ]),
      };
    }
  }

  return {
    status: 'matched',
    records: out,
    reasonCodes: stableUnique([...reasonCodes, 'normalized']),
  };
}

export function createEmptyProductKnowledgeProvider(
  providerId: string,
  defaultScope: KnowledgeScope = 'personal'
): ProductKnowledgeProvider {
  return {
    providerId,
    defaultScope,
    lookup(_query: ValidatedProductKnowledgeQuery): ProductKnowledgeLookupResult {
      return {
        status: 'no_match',
        records: [],
        reasonCodes: ['no_match'],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Insight evidence ladder (ordinal only)
// ---------------------------------------------------------------------------

export type InsightEvidenceLevel =
  | 'observation'
  | 'history'
  | 'pattern'
  | 'prediction'
  | 'action';

const EVIDENCE_LEVEL_RANK: Record<InsightEvidenceLevel, number> = {
  observation: 0,
  history: 1,
  pattern: 2,
  prediction: 3,
  action: 4,
};

export function insightEvidenceLevelRank(level: InsightEvidenceLevel): number {
  return EVIDENCE_LEVEL_RANK[level];
}

/** Ordinal compatibility only — not real underlying evidence validation. */
export function insightEvidenceLevelOrdinalCompatible(
  providedEvidenceLevel: InsightEvidenceLevel,
  requiredClaimLevel: InsightEvidenceLevel
): boolean {
  return (
    insightEvidenceLevelRank(providedEvidenceLevel) >=
    insightEvidenceLevelRank(requiredClaimLevel)
  );
}

/** @deprecated Prefer insightEvidenceLevelOrdinalCompatible. */
export function insightEvidenceSatisfies(
  actual: InsightEvidenceLevel,
  required: InsightEvidenceLevel
): boolean {
  return insightEvidenceLevelOrdinalCompatible(actual, required);
}

export type InsightClaimValidation = {
  ok: boolean;
  reasonCodes: string[];
};

export function validateInsightEvidenceClaim(input: {
  declaredEvidenceLevel: InsightEvidenceLevel;
  assertedClaimLevel: InsightEvidenceLevel;
}): InsightClaimValidation {
  if (
    !insightEvidenceLevelOrdinalCompatible(
      input.declaredEvidenceLevel,
      input.assertedClaimLevel
    )
  ) {
    return {
      ok: false,
      reasonCodes: [
        'insufficient_evidence_level_for_claim',
        `declared=${input.declaredEvidenceLevel}`,
        `asserted=${input.assertedClaimLevel}`,
      ],
    };
  }
  return { ok: true, reasonCodes: ['evidence_level_ordinal_ok'] };
}

/** Memory recognition never authorizes exact price comparison. Always false. */
export function memoryClaimAuthorizesExactPriceComparison(): false {
  return false;
}

// ---------------------------------------------------------------------------
// Memory identity evidence
// ---------------------------------------------------------------------------

export type MemoryIdentityStatus =
  | 'unresolved'
  | 'candidate'
  | 'confirmed';

export type MemoryIdentityEvidence = {
  status: MemoryIdentityStatus;
  identityLevel: ProductIdentityLevel;
  identityConfidence: number;
  identitySource: string;
  merchantProductId?: string | null;
  canonicalProductId?: string | null;
  skuId?: string | null;
  evidence: readonly string[];
};

export type MemoryIdentityValidation = {
  ok: boolean;
  status: MemoryIdentityStatus;
  reasonCodes: string[];
};

const IDENTITY_LEVEL_SET = new Set<string>(PRODUCT_IDENTITY_LEVELS);

export function validateMemoryIdentityEvidence(
  input: unknown
): MemoryIdentityValidation {
  if (input == null || typeof input !== 'object') {
    return {
      ok: false,
      status: 'unresolved',
      reasonCodes: ['invalid_memory_identity_evidence'],
    };
  }
  const e = input as MemoryIdentityEvidence;
  const reasonCodes: string[] = [];

  if (
    e.status !== 'unresolved' &&
    e.status !== 'candidate' &&
    e.status !== 'confirmed'
  ) {
    return {
      ok: false,
      status: 'unresolved',
      reasonCodes: ['unknown_memory_identity_status'],
    };
  }
  if (
    typeof e.identityLevel !== 'string' ||
    !IDENTITY_LEVEL_SET.has(e.identityLevel)
  ) {
    return {
      ok: false,
      status: 'unresolved',
      reasonCodes: ['unknown_or_invalid_identity_level'],
    };
  }
  if (!isValidConfidence(e.identityConfidence)) {
    return {
      ok: false,
      status: 'unresolved',
      reasonCodes: ['invalid_identity_confidence'],
    };
  }

  if (e.status === 'confirmed') {
    if (e.identityLevel === 'unresolved') {
      reasonCodes.push('confirmed_requires_resolved_identity_level');
      return { ok: false, status: 'unresolved', reasonCodes };
    }
    if (typeof e.identitySource !== 'string' || e.identitySource.trim() === '') {
      reasonCodes.push('confirmed_requires_identity_source');
      return { ok: false, status: 'unresolved', reasonCodes };
    }
    const ev = canonicalizeStringArray(e.evidence, 'evidence', reasonCodes);
    if (ev == null || ev.length === 0) {
      reasonCodes.push('confirmed_requires_supporting_evidence');
      return { ok: false, status: 'unresolved', reasonCodes };
    }
  }

  return {
    ok: true,
    status: e.status,
    reasonCodes: ['memory_identity_evidence_ok'],
  };
}

// ---------------------------------------------------------------------------
// Pattern evidence
// ---------------------------------------------------------------------------

export type PatternEvidenceKind = 'frequency' | 'cycle';

export type PatternEvidenceSignal = {
  kind: PatternEvidenceKind;
  confidence: number;
  trusted: boolean;
  eligibility: ClaimEligibility;
  provenance: readonly string[];
  reasonCodes?: readonly string[];
};

export type PatternEvidenceValidation = {
  ok: boolean;
  usable: boolean;
  reasonCodes: string[];
};

export function validatePatternEvidenceSignal(
  input: unknown
): PatternEvidenceValidation {
  const reasonCodes: string[] = [];
  if (input == null || typeof input !== 'object') {
    return {
      ok: false,
      usable: false,
      reasonCodes: ['invalid_pattern_evidence'],
    };
  }
  const s = input as PatternEvidenceSignal;
  if (s.kind !== 'frequency' && s.kind !== 'cycle') {
    return {
      ok: false,
      usable: false,
      reasonCodes: ['unknown_pattern_evidence_kind'],
    };
  }
  if (!isValidConfidence(s.confidence)) {
    reasonCodes.push('invalid_pattern_confidence');
  }
  if (typeof s.trusted !== 'boolean') {
    reasonCodes.push('invalid_trusted_flag');
  }
  if (
    s.eligibility == null ||
    typeof s.eligibility !== 'object' ||
    typeof (s.eligibility as ClaimEligibility).status !== 'string'
  ) {
    reasonCodes.push('invalid_pattern_eligibility');
  }
  const prov = canonicalizeStringArray(s.provenance, 'provenance', reasonCodes);
  if (prov == null || (prov.length === 0 && !reasonCodes.includes('provenance_not_array'))) {
    if (prov != null && prov.length === 0) {
      reasonCodes.push('empty_pattern_provenance');
    }
  }
  if (reasonCodes.length > 0) {
    return { ok: false, usable: false, reasonCodes };
  }

  const elig = (s.eligibility as ClaimEligibility).status;
  if (elig === 'insufficient_evidence' || elig === 'conflicting_evidence') {
    return {
      ok: true,
      usable: false,
      reasonCodes: ['pattern_eligibility_blocks_promotion'],
    };
  }
  if (elig !== 'eligible' && elig !== 'eligible_with_caution') {
    return {
      ok: true,
      usable: false,
      reasonCodes: ['pattern_eligibility_blocks_promotion'],
    };
  }
  if (s.trusted !== true) {
    return { ok: true, usable: false, reasonCodes: ['pattern_not_trusted'] };
  }
  return {
    ok: true,
    usable: true,
    reasonCodes: ['pattern_evidence_usable'],
  };
}

// ---------------------------------------------------------------------------
// Purchase Memory
// ---------------------------------------------------------------------------

export type PurchaseMemoryStage =
  | 'seen'
  | 'repeated'
  | 'frequent'
  | 'cycle_candidate';

export type PurchaseMemoryFacts = {
  distinctPurchaseEventCount: number;
  totalUnitsPurchased: number | null;
  firstPurchasedAt: number | null;
  lastPurchasedAt: number | null;
};

export type PurchaseMemoryObservation = {
  purchaseEventKey: string;
  units: number;
  purchasedAt: number | null;
};

export type PurchaseMemoryAggregationResult = {
  facts: PurchaseMemoryFacts;
  reasonCodes: string[];
  unitsTrusted: boolean;
  temporalTrusted: boolean;
};

/** Deterministic floating sum: sort ascending then Kahan summation. */
export function deterministicSum(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let sum = 0;
  let c = 0;
  for (const v of sorted) {
    const y = v - c;
    const t = sum + y;
    c = t - sum - y;
    sum = t;
  }
  return sum;
}

function isFiniteNumberOrNull(v: unknown): v is number | null {
  if (v === null) return true;
  return typeof v === 'number' && Number.isFinite(v);
}

export type PurchaseMemoryFactsValidation = {
  /** Count/units structurally usable for stage evaluation. */
  ok: boolean;
  temporalOk: boolean;
  reasonCodes: string[];
  /** Timestamps sanitized (NaN/Inf cleared; first>last → both null). */
  sanitizedFacts: PurchaseMemoryFacts | null;
};

/**
 * Validate direct PurchaseMemoryFacts.
 * Does not swap first/last when first > last — that is conflicting evidence.
 */
export function validatePurchaseMemoryFacts(
  facts: unknown
): PurchaseMemoryFactsValidation {
  if (facts == null || typeof facts !== 'object') {
    return {
      ok: false,
      temporalOk: false,
      reasonCodes: ['invalid_purchase_memory_facts'],
      sanitizedFacts: null,
    };
  }
  const f = facts as PurchaseMemoryFacts;
  const reasonCodes: string[] = [];
  const count = f.distinctPurchaseEventCount;
  if (
    typeof count !== 'number' ||
    !Number.isFinite(count) ||
    !Number.isInteger(count) ||
    count < 0
  ) {
    reasonCodes.push('invalid_distinct_purchase_event_count');
  }
  const units = f.totalUnitsPurchased;
  if (units !== null) {
    if (typeof units !== 'number' || !Number.isFinite(units) || units < 0) {
      reasonCodes.push('invalid_total_units_purchased');
    }
  }

  let temporalOk = true;
  let first = f.firstPurchasedAt;
  let last = f.lastPurchasedAt;

  if (!isFiniteNumberOrNull(first)) {
    temporalOk = false;
    reasonCodes.push('invalid_temporal_fact');
    reasonCodes.push('invalid_first_purchased_at');
    first = null;
  }
  if (!isFiniteNumberOrNull(last)) {
    temporalOk = false;
    reasonCodes.push('invalid_temporal_fact');
    reasonCodes.push('invalid_last_purchased_at');
    last = null;
  }
  if (
    typeof first === 'number' &&
    typeof last === 'number' &&
    first > last
  ) {
    temporalOk = false;
    reasonCodes.push('conflicting_temporal_fact');
    // Do not swap — clear temporal range.
    first = null;
    last = null;
  }

  if (reasonCodes.some((c) => c.startsWith('invalid_distinct') || c.startsWith('invalid_total'))) {
    return {
      ok: false,
      temporalOk,
      reasonCodes: stableUnique(reasonCodes),
      sanitizedFacts: null,
    };
  }

  return {
    ok: true,
    temporalOk,
    reasonCodes: stableUnique(
      reasonCodes.length > 0 ? reasonCodes : ['purchase_memory_facts_ok']
    ),
    sanitizedFacts: {
      distinctPurchaseEventCount: count,
      totalUnitsPurchased: units,
      firstPurchasedAt: first,
      lastPurchasedAt: last,
    },
  };
}

export function aggregatePurchaseMemoryFacts(
  observations: readonly PurchaseMemoryObservation[]
): PurchaseMemoryAggregationResult {
  const reasonCodes: string[] = [];
  if (observations.length === 0) {
    return {
      facts: {
        distinctPurchaseEventCount: 0,
        totalUnitsPurchased: 0,
        firstPurchasedAt: null,
        lastPurchasedAt: null,
      },
      reasonCodes: ['no_observations'],
      unitsTrusted: true,
      temporalTrusted: true,
    };
  }

  type Acc = { units: number[]; times: number[]; missingTime: boolean };
  const byEvent = new Map<string, Acc>();
  let unitsTrusted = true;
  let temporalTrusted = true;

  for (const obs of observations) {
    const key =
      typeof obs.purchaseEventKey === 'string'
        ? obs.purchaseEventKey.trim()
        : '';
    if (key === '') {
      reasonCodes.push('invalid_purchase_event_key');
      continue;
    }
    const cur = byEvent.get(key) ?? {
      units: [],
      times: [],
      missingTime: false,
    };
    const units = obs.units;
    if (typeof units !== 'number' || !Number.isFinite(units) || units < 0) {
      unitsTrusted = false;
      reasonCodes.push('invalid_units');
    } else {
      cur.units.push(units);
    }
    if (obs.purchasedAt == null) {
      cur.missingTime = true;
    } else if (
      typeof obs.purchasedAt !== 'number' ||
      !Number.isFinite(obs.purchasedAt)
    ) {
      temporalTrusted = false;
      reasonCodes.push('invalid_purchased_at');
    } else {
      cur.times.push(obs.purchasedAt);
    }
    byEvent.set(key, cur);
  }

  const eventKeys = [...byEvent.keys()].sort(strcmp);
  const allUnits: number[] = [];
  const allTimes: number[] = [];

  for (const key of eventKeys) {
    const e = byEvent.get(key)!;
    // Event-local deterministic unit collection.
    for (const u of e.units) allUnits.push(u);
    const uniqTimes = [...new Set(e.times)].sort((a, b) => a - b);
    if (uniqTimes.length > 1) {
      temporalTrusted = false;
      reasonCodes.push('conflicting_event_timestamp');
      reasonCodes.push(`eventKey=${key}`);
    } else if (uniqTimes.length === 1) {
      allTimes.push(uniqTimes[0]!);
    }
    if (e.missingTime && uniqTimes.length === 1) {
      reasonCodes.push('partial_missing_event_timestamp');
    }
  }

  allTimes.sort((a, b) => a - b);
  const totalUnits = unitsTrusted ? deterministicSum(allUnits) : null;

  return {
    facts: {
      distinctPurchaseEventCount: eventKeys.length,
      totalUnitsPurchased: totalUnits,
      firstPurchasedAt:
        temporalTrusted && allTimes.length > 0 ? allTimes[0]! : null,
      lastPurchasedAt:
        temporalTrusted && allTimes.length > 0
          ? allTimes[allTimes.length - 1]!
          : null,
    },
    reasonCodes: stableUnique(reasonCodes),
    unitsTrusted,
    temporalTrusted,
  };
}

export type PurchaseMemoryEvidenceSignals = {
  frequencyEvidence?: PatternEvidenceSignal | null;
  cycleEvidence?: PatternEvidenceSignal | null;
  identity: MemoryIdentityEvidence;
  conflicts?: readonly string[];
};

export type PurchaseMemoryEvaluation = {
  stage: PurchaseMemoryStage | null;
  evidenceLevel: InsightEvidenceLevel | null;
  eligibility: ClaimEligibility;
  identityStatus: MemoryIdentityStatus;
  reasonCodes: string[];
  facts: PurchaseMemoryFacts;
};

function isUsablePromotionSignal(
  signal: PatternEvidenceSignal | null | undefined,
  expectedKind: PatternEvidenceKind,
  reasonCodes: string[]
): { usable: boolean; caution: boolean } {
  if (signal == null) {
    reasonCodes.push(`${expectedKind}_evidence_absent`);
    return { usable: false, caution: false };
  }
  if (signal.kind !== expectedKind) {
    reasonCodes.push(`${expectedKind}_evidence_kind_mismatch`);
    return { usable: false, caution: false };
  }
  const v = validatePatternEvidenceSignal(signal);
  reasonCodes.push(...v.reasonCodes.map((r) => `${expectedKind}:${r}`));
  if (!v.usable) return { usable: false, caution: false };
  return {
    usable: true,
    caution: signal.eligibility.status === 'eligible_with_caution',
  };
}

export function evaluatePurchaseMemory(input: {
  facts: PurchaseMemoryFacts;
  evidence: PurchaseMemoryEvidenceSignals;
}): PurchaseMemoryEvaluation {
  const reasonCodes: string[] = [];
  const factsCheck = validatePurchaseMemoryFacts(input.facts);
  if (!factsCheck.ok || factsCheck.sanitizedFacts == null) {
    reasonCodes.push(...factsCheck.reasonCodes);
    return {
      stage: null,
      evidenceLevel: null,
      eligibility: claimEligibility('insufficient_evidence', reasonCodes),
      identityStatus: 'unresolved',
      reasonCodes: stableUnique(reasonCodes),
      facts: input.facts,
    };
  }

  const facts = factsCheck.sanitizedFacts;
  if (!factsCheck.temporalOk) {
    reasonCodes.push(...factsCheck.reasonCodes.filter((c) => c !== 'purchase_memory_facts_ok'));
  }

  const identityVal = validateMemoryIdentityEvidence(input.evidence.identity);
  reasonCodes.push(...identityVal.reasonCodes);
  const identityStatus = identityVal.status;
  if (!identityVal.ok) reasonCodes.push('identity_evidence_demoted');

  const conflicts = stableUnique([...(input.evidence.conflicts ?? [])]);
  if (conflicts.length > 0) {
    reasonCodes.push('conflicting_evidence');
    for (const c of conflicts) reasonCodes.push(`conflict=${c}`);
  }

  const count = facts.distinctPurchaseEventCount;
  if (count < 1) {
    reasonCodes.push('no_purchase_events');
    return {
      stage: null,
      evidenceLevel: null,
      eligibility: claimEligibility('insufficient_evidence', reasonCodes),
      identityStatus,
      reasonCodes: stableUnique(reasonCodes),
      facts,
    };
  }

  let stage: PurchaseMemoryStage = 'seen';
  let evidenceLevel: InsightEvidenceLevel = 'observation';
  reasonCodes.push('stage=seen');

  if (count >= 2) {
    stage = 'repeated';
    evidenceLevel = 'history';
    reasonCodes.push('stage=repeated');
  }

  let cautionFromPattern = false;
  const freq = isUsablePromotionSignal(
    input.evidence.frequencyEvidence,
    'frequency',
    reasonCodes
  );
  if (freq.usable && count >= 2) {
    stage = 'frequent';
    evidenceLevel = 'pattern';
    reasonCodes.push('stage=frequent');
    if (freq.caution) cautionFromPattern = true;
  } else if (count >= 2 && input.evidence.frequencyEvidence == null) {
    reasonCodes.push('frequency_evidence_absent_no_auto_frequent');
  }

  const cycle = isUsablePromotionSignal(
    input.evidence.cycleEvidence,
    'cycle',
    reasonCodes
  );
  if (cycle.usable && count >= 2) {
    stage = 'cycle_candidate';
    evidenceLevel = 'pattern';
    reasonCodes.push('stage=cycle_candidate');
    if (cycle.caution) cautionFromPattern = true;
  } else if (input.evidence.cycleEvidence == null) {
    reasonCodes.push('cycle_evidence_absent_no_auto_cycle');
  }

  reasonCodes.push('no_auto_prediction');
  reasonCodes.push('no_auto_action');
  reasonCodes.push('memory_does_not_authorize_exact_price');

  let eligibilityStatus: ClaimEligibilityStatus = 'eligible';
  if (conflicts.length > 0) {
    eligibilityStatus = 'conflicting_evidence';
  } else if (!identityVal.ok || identityStatus === 'unresolved') {
    eligibilityStatus = 'insufficient_evidence';
    reasonCodes.push('identity_unresolved_for_memory_claim');
  } else if (
    identityStatus === 'candidate' ||
    cautionFromPattern ||
    !factsCheck.temporalOk
  ) {
    eligibilityStatus = 'eligible_with_caution';
    if (identityStatus === 'candidate') {
      reasonCodes.push('identity_candidate_conservative_memory_ok');
    }
    if (cautionFromPattern) {
      reasonCodes.push('pattern_evidence_caution_propagated');
    }
    if (!factsCheck.temporalOk) {
      reasonCodes.push('temporal_facts_caution');
    }
  } else {
    reasonCodes.push('identity_confirmed_for_memory_claim');
  }

  return {
    stage,
    evidenceLevel,
    eligibility: claimEligibility(eligibilityStatus, reasonCodes),
    identityStatus,
    reasonCodes: stableUnique(reasonCodes),
    facts,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function strcmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function stableUnique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const sorted = [...values].sort(strcmp);
  for (const v of sorted) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
