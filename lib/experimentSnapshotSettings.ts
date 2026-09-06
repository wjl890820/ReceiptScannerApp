/**
 * Developer-only convenience storage for Experiment Snapshot metadata.
 * Research metadata only — never product / receipt / identity truth.
 *
 * Storage persists phase + completedReceiptSequence only.
 * nextReceiptSequence is always derived as completed + 1 (never stored as truth).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export const EXPERIMENT_SNAPSHOT_COMPLETED_SEQUENCE_KEY =
  'settings.experimentSnapshot.completedReceiptSequence.v1';

export const EXPERIMENT_SNAPSHOT_PHASE_KEY =
  'settings.experimentSnapshot.phase.v1';

/** Phase 2 baseline defaults (UI convenience only — not hardcoded into assembler). */
export const EXPERIMENT_SNAPSHOT_DEFAULT_PHASE = 2;
export const EXPERIMENT_SNAPSHOT_DEFAULT_COMPLETED_SEQUENCE = 37;

export type ExperimentSnapshotSequencePreference = {
  phase: number;
  completedReceiptSequence: number;
  /** Derived display field only — never independent stored truth. */
  nextReceiptSequence: number;
};

export class InvalidExperimentSnapshotExperimentMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExperimentSnapshotExperimentMetaError';
  }
}

export function deriveNextReceiptSequence(
  completedReceiptSequence: number
): number {
  return completedReceiptSequence + 1;
}

/**
 * Strict assembler/UI contract: integers only, no floor/coercion.
 * next is always completed + 1.
 */
export function assertExperimentSnapshotExperimentInput(input: {
  phase: number;
  completedReceiptSequence: number;
}): ExperimentSnapshotSequencePreference {
  if (typeof input.phase !== 'number' || !Number.isInteger(input.phase) || input.phase < 1) {
    throw new InvalidExperimentSnapshotExperimentMetaError(
      'invalid_experiment_snapshot_phase'
    );
  }
  if (
    typeof input.completedReceiptSequence !== 'number' ||
    !Number.isInteger(input.completedReceiptSequence) ||
    input.completedReceiptSequence < 0
  ) {
    throw new InvalidExperimentSnapshotExperimentMetaError(
      'invalid_experiment_snapshot_completed_receipt_sequence'
    );
  }
  return {
    phase: input.phase,
    completedReceiptSequence: input.completedReceiptSequence,
    nextReceiptSequence: deriveNextReceiptSequence(input.completedReceiptSequence),
  };
}

function parseStoredStrictInteger(
  raw: string | null | undefined,
  fallback: number,
  min: number
): number {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return fallback;
  return n;
}

/**
 * UI convenience loader. Corrupt/fractional stored values fall back to defaults
 * (never floor/coerce into a fake experiment sequence).
 */
export function readExperimentSnapshotSequencePreferenceFromStorageValues(input: {
  phaseRaw?: string | null;
  completedRaw?: string | null;
}): ExperimentSnapshotSequencePreference {
  const phase = parseStoredStrictInteger(
    input.phaseRaw,
    EXPERIMENT_SNAPSHOT_DEFAULT_PHASE,
    1
  );
  const completed = parseStoredStrictInteger(
    input.completedRaw,
    EXPERIMENT_SNAPSHOT_DEFAULT_COMPLETED_SEQUENCE,
    0
  );
  return assertExperimentSnapshotExperimentInput({
    phase,
    completedReceiptSequence: completed,
  });
}

export async function getExperimentSnapshotSequencePreference(): Promise<ExperimentSnapshotSequencePreference> {
  try {
    const [phaseRaw, completedRaw] = await Promise.all([
      AsyncStorage.getItem(EXPERIMENT_SNAPSHOT_PHASE_KEY),
      AsyncStorage.getItem(EXPERIMENT_SNAPSHOT_COMPLETED_SEQUENCE_KEY),
    ]);
    return readExperimentSnapshotSequencePreferenceFromStorageValues({
      phaseRaw,
      completedRaw,
    });
  } catch {
    return assertExperimentSnapshotExperimentInput({
      phase: EXPERIMENT_SNAPSHOT_DEFAULT_PHASE,
      completedReceiptSequence: EXPERIMENT_SNAPSHOT_DEFAULT_COMPLETED_SEQUENCE,
    });
  }
}

/**
 * Persists UI convenience only (phase + completed).
 * Does not store next. Does not increment on export success.
 */
export async function setExperimentSnapshotSequencePreference(input: {
  phase?: number;
  completedReceiptSequence: number;
}): Promise<ExperimentSnapshotSequencePreference> {
  const normalized = assertExperimentSnapshotExperimentInput({
    phase: input.phase ?? EXPERIMENT_SNAPSHOT_DEFAULT_PHASE,
    completedReceiptSequence: input.completedReceiptSequence,
  });
  try {
    await AsyncStorage.setItem(
      EXPERIMENT_SNAPSHOT_PHASE_KEY,
      String(normalized.phase)
    );
    await AsyncStorage.setItem(
      EXPERIMENT_SNAPSHOT_COMPLETED_SEQUENCE_KEY,
      String(normalized.completedReceiptSequence)
    );
  } catch {
    // ignore storage failures — export can still proceed with in-memory values
  }
  return normalized;
}
