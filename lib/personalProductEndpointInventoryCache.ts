/**
 * Session cache for owner-scoped personal product endpoint inventory.
 *
 * Cross-focus reuse for Home / History. No SQLite persistence.
 * Invalidation is explicit (truth mutations), not TTL-primary.
 */

import type { PersonalProductEndpointInventoryLoadResult } from './personalProductEndpointInventory';
import { PRODUCT_IDENTITY_RESOLVER_VERSION } from './productIdentityContract';
import { PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION } from './personalProductIdentityContract';
import { logger } from './logger';

export type PersonalProductInventoryInvalidationReason =
  | 'receipt_saved'
  | 'receipt_updated'
  | 'receipt_deleted'
  | 'receipts_cleared'
  | 'identity_decision'
  | 'cloud_restore'
  | 'ownership_adoption'
  | 'category_backfill'
  | 'receipt_item_index'
  | 'test_reset';

export type PersonalProductInventoryCacheKeyParts = {
  ownerKey: string;
  dataGeneration: number;
  resolverVersion: string;
  pipelineVersion: string;
};

export type PersonalProductInventoryCachedReady = {
  status: 'ready';
  inventory: Extract<
    PersonalProductEndpointInventoryLoadResult,
    { status: 'ready' }
  >['inventory'];
};

type CacheEntry = {
  key: string;
  ownerKey: string;
  dataGeneration: number;
  resolverVersion: string;
  pipelineVersion: string;
  result: PersonalProductInventoryCachedReady;
  rowCount: number;
  resolveCount: number;
};

let dataGeneration = 0;
let entry: CacheEntry | null = null;
let inFlight: {
  key: string;
  promise: Promise<PersonalProductEndpointInventoryLoadResult>;
} | null = null;
let fullBuildCount = 0;

export function getPersonalProductInventoryDataGeneration(): number {
  return dataGeneration;
}

export function getPersonalProductInventoryFullBuildCount(): number {
  return fullBuildCount;
}

export function __resetPersonalProductEndpointInventoryCacheForTests(): void {
  dataGeneration = 0;
  entry = null;
  inFlight = null;
  fullBuildCount = 0;
}

export function buildPersonalProductInventoryCacheKey(
  parts: PersonalProductInventoryCacheKeyParts
): string {
  return [
    `o=${parts.ownerKey}`,
    `g=${parts.dataGeneration}`,
    `rv=${parts.resolverVersion}`,
    `pv=${parts.pipelineVersion}`,
  ].join('|');
}

export function currentPersonalProductInventoryCacheKeyParts(
  ownerKey: string
): PersonalProductInventoryCacheKeyParts {
  return {
    ownerKey,
    dataGeneration,
    resolverVersion: PRODUCT_IDENTITY_RESOLVER_VERSION,
    pipelineVersion: PERSONAL_PRODUCT_IDENTITY_PIPELINE_VERSION,
  };
}

/**
 * Truth-change invalidation. Clears ready cache and drops in-flight so a
 * concurrent builder cannot repopulate stale data after mutation.
 */
export function invalidatePersonalProductEndpointInventory(
  reason: PersonalProductInventoryInvalidationReason | string
): void {
  dataGeneration += 1;
  entry = null;
  inFlight = null;
  logger.info('InventoryPerf', `invalidated reason=${reason} generation=${dataGeneration}`);
}

export function readPersonalProductEndpointInventoryCache(
  key: string
): PersonalProductInventoryCachedReady | null {
  if (!entry || entry.key !== key) return null;
  return entry.result;
}

export function writePersonalProductEndpointInventoryCache(input: {
  key: string;
  ownerKey: string;
  dataGeneration: number;
  resolverVersion: string;
  pipelineVersion: string;
  result: PersonalProductInventoryCachedReady;
  rowCount: number;
  resolveCount: number;
}): void {
  entry = {
    key: input.key,
    ownerKey: input.ownerKey,
    dataGeneration: input.dataGeneration,
    resolverVersion: input.resolverVersion,
    pipelineVersion: input.pipelineVersion,
    result: input.result,
    rowCount: input.rowCount,
    resolveCount: input.resolveCount,
  };
  fullBuildCount += 1;
}

export function getPersonalProductInventoryInFlight(
  key: string
): Promise<PersonalProductEndpointInventoryLoadResult> | null {
  if (!inFlight || inFlight.key !== key) return null;
  return inFlight.promise;
}

export function setPersonalProductInventoryInFlight(
  key: string,
  promise: Promise<PersonalProductEndpointInventoryLoadResult>
): void {
  inFlight = { key, promise };
}

export function clearPersonalProductInventoryInFlight(key: string): void {
  if (inFlight?.key === key) {
    inFlight = null;
  }
}

export function logPersonalProductInventoryPerf(input: {
  cache: 'HIT' | 'MISS' | 'JOIN';
  durationMs: number;
  rows?: number;
  resolves?: number;
  generation?: number;
}): void {
  const parts = [
    `cache=${input.cache}`,
    `durationMs=${input.durationMs}`,
  ];
  if (input.generation != null) {
    parts.push(`generation=${input.generation}`);
  }
  if (input.cache !== 'HIT') {
    if (input.rows != null) parts.push(`rows=${input.rows}`);
    if (input.resolves != null) parts.push(`resolves=${input.resolves}`);
  }
  logger.info('InventoryPerf', parts.join(' '));
}
