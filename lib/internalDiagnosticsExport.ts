/**
 * Build + share Internal Diagnostics V1 export package.
 * Manual share only — never auto-upload.
 */

import {
  flushDiagnosticsPersistence,
  getDiagnosticSnapshot,
  hydrateInternalDiagnostics,
  recordDiagnosticEvent,
} from './internalDiagnostics';
import { collectInternalDiagnosticsDataScale } from './internalDiagnosticsDataScale';
import { isInternalDiagnosticsEnabled } from './internalDiagnosticsGate';
import { INTERNAL_DIAGNOSTICS_SCHEMA_VERSION } from './internalDiagnosticsTypes';

export type InternalDiagnosticsExportPackage = {
  schemaVersion: number;
  generatedAt: string;
  generatedAtMs: number;
  app: {
    version: string;
    build: string;
    name: string;
  };
  device: {
    platform: string;
    osVersion: string | null;
    model: string | null;
  };
  featureFlags: {
    ANALYSIS_PRICE_CHANGES_ENABLED: boolean;
    ENABLE_INTERNAL_DIAGNOSTICS: boolean;
    ENABLE_ANALYSIS_D_DIAGNOSTICS: boolean;
    ENABLE_ANON_AUTH: boolean;
    ENABLE_CLOUD_BACKUP: boolean;
    ENABLE_APPLE_LINK: boolean;
  };
  dataScale: Awaited<ReturnType<typeof collectInternalDiagnosticsDataScale>>;
  session: {
    sessionId: string;
    sessionStartedAt: number;
    eventCount: number;
    capacity: number;
    locale: string;
  };
  events: ReturnType<typeof getDiagnosticSnapshot>['events'];
  privacy: {
    includesRawReceiptContent: false;
    includesProductNames: false;
    includesMerchantNames: false;
    includesImages: false;
    includesCredentials: false;
  };
};

export type BuildInternalDiagnosticsExportDeps = {
  nowMs?: number;
  app?: { version: string; build: string; name: string };
  device?: {
    platform: string;
    osVersion: string | null;
    model: string | null;
  };
  locale?: string;
  collectDataScale?: () => Promise<
    Awaited<ReturnType<typeof collectInternalDiagnosticsDataScale>>
  >;
  readFeatureFlags?: () => InternalDiagnosticsExportPackage['featureFlags'];
};

const ANALYSIS_PRICE_CHANGES_ENABLED_MIRROR = false;

let exportInProgress = false;

/** Test seam / Settings parallel-tap guard. */
export function isInternalDiagnosticsExportInProgress(): boolean {
  return exportInProgress;
}

export function resetInternalDiagnosticsExportGuardForTests(): void {
  exportInProgress = false;
}

export function buildInternalDiagnosticsFilename(
  nowMs: number = Date.now()
): string {
  const d = new Date(nowMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `meruno-diagnostics-${stamp}.json`;
}

function readAnalysisPriceChangesFlag(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const gate = require('./analysisPriceChangesGate') as {
      isAnalysisPriceChangesEnabled?: () => boolean;
    };
    return Boolean(gate.isAnalysisPriceChangesEnabled?.());
  } catch {
    return ANALYSIS_PRICE_CHANGES_ENABLED_MIRROR;
  }
}

function defaultFeatureFlags(): InternalDiagnosticsExportPackage['featureFlags'] {
  return {
    ANALYSIS_PRICE_CHANGES_ENABLED: ANALYSIS_PRICE_CHANGES_ENABLED_MIRROR,
    ENABLE_INTERNAL_DIAGNOSTICS: isInternalDiagnosticsEnabled(),
    ENABLE_ANALYSIS_D_DIAGNOSTICS: false,
    ENABLE_ANON_AUTH: false,
    ENABLE_CLOUD_BACKUP: false,
    ENABLE_APPLE_LINK: false,
  };
}

function readRuntimeFeatureFlags(): InternalDiagnosticsExportPackage['featureFlags'] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const env = require('./env') as {
      isAnalysisDDiagnosticsEnabled?: () => boolean;
      isAnonAuthEnabled?: () => boolean;
      isCloudBackupEnabled?: () => boolean;
      isAppleLinkEnabled?: () => boolean;
    };
    return {
      ANALYSIS_PRICE_CHANGES_ENABLED: readAnalysisPriceChangesFlag(),
      ENABLE_INTERNAL_DIAGNOSTICS: isInternalDiagnosticsEnabled(),
      ENABLE_ANALYSIS_D_DIAGNOSTICS: Boolean(
        env.isAnalysisDDiagnosticsEnabled?.()
      ),
      ENABLE_ANON_AUTH: Boolean(env.isAnonAuthEnabled?.()),
      ENABLE_CLOUD_BACKUP: Boolean(env.isCloudBackupEnabled?.()),
      ENABLE_APPLE_LINK: Boolean(env.isAppleLinkEnabled?.()),
    };
  } catch {
    return defaultFeatureFlags();
  }
}

function readRuntimeAppMeta(): { version: string; build: string; name: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Constants = require('expo-constants').default as {
      nativeAppVersion?: string | null;
      nativeBuildVersion?: string | null;
      expoConfig?: { version?: string | null; name?: string | null } | null;
    };
    const version =
      String(Constants.nativeAppVersion ?? '').trim() ||
      String(Constants.expoConfig?.version ?? '').trim() ||
      '—';
    const build = String(Constants.nativeBuildVersion ?? '').trim() || '—';
    const name =
      String(Constants.expoConfig?.name ?? '').trim() || 'Receipt Scanner';
    return { version, build, name };
  } catch {
    return { version: '—', build: '—', name: 'Receipt Scanner' };
  }
}

function readRuntimeDeviceMeta(): {
  platform: string;
  osVersion: string | null;
  model: string | null;
} {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Platform } = require('react-native') as {
      Platform: { OS: string; Version?: string | number };
    };
    const osVersion =
      typeof Platform.Version === 'string'
        ? Platform.Version
        : String(Platform.Version ?? '');
    let model: string | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Constants = require('expo-constants').default as {
        deviceName?: string;
      };
      model =
        typeof Constants.deviceName === 'string' ? Constants.deviceName : null;
    } catch {
      model = null;
    }
    return {
      platform: Platform.OS,
      osVersion: osVersion || null,
      model,
    };
  } catch {
    return { platform: 'unknown', osVersion: null, model: null };
  }
}

function readRuntimeLocale(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCurrentLocale } = require('./i18n') as {
      getCurrentLocale: () => string;
    };
    return getCurrentLocale();
  } catch {
    return 'en';
  }
}

export async function buildInternalDiagnosticsExportPackage(
  deps: BuildInternalDiagnosticsExportDeps = {}
): Promise<InternalDiagnosticsExportPackage> {
  await hydrateInternalDiagnostics();
  await flushDiagnosticsPersistence();

  // ONE stable snapshot — events and eventCount must agree.
  const snapshot = getDiagnosticSnapshot();
  const collect =
    deps.collectDataScale ?? collectInternalDiagnosticsDataScale;
  const dataScale = await collect();
  const nowMs = deps.nowMs ?? Date.now();

  const pkg: InternalDiagnosticsExportPackage = {
    schemaVersion: INTERNAL_DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    generatedAtMs: nowMs,
    app: deps.app ?? readRuntimeAppMeta(),
    device: deps.device ?? readRuntimeDeviceMeta(),
    featureFlags: deps.readFeatureFlags
      ? deps.readFeatureFlags()
      : readRuntimeFeatureFlags(),
    dataScale,
    session: {
      sessionId: snapshot.sessionId,
      sessionStartedAt: snapshot.sessionStartedAt,
      eventCount: snapshot.events.length,
      capacity: snapshot.capacity,
      locale: deps.locale ?? readRuntimeLocale(),
    },
    events: snapshot.events,
    privacy: {
      includesRawReceiptContent: false,
      includesProductNames: false,
      includesMerchantNames: false,
      includesImages: false,
      includesCredentials: false,
    },
  };

  // Record after snapshot so export metadata stays consistent.
  recordDiagnosticEvent({
    category: 'export',
    name: 'diagnostics_export_built',
    screen: 'diagnostics',
    meta: { eventCount: pkg.session.eventCount },
  });

  return pkg;
}

export function serializeInternalDiagnosticsExport(
  pkg: InternalDiagnosticsExportPackage
): string {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export type WriteInternalDiagnosticsExportFileDeps = {
  json: string;
  cacheDirectory: string | null | undefined;
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>;
  nowMs?: number;
};

export async function writeInternalDiagnosticsExportFile(
  deps: WriteInternalDiagnosticsExportFileDeps
): Promise<{ fileUri: string; filename: string; json: string }> {
  if (!deps.cacheDirectory) {
    throw new Error(
      'Cache directory unavailable; cannot export diagnostics JSON file.'
    );
  }
  const filename = buildInternalDiagnosticsFilename(deps.nowMs);
  const fileUri = `${deps.cacheDirectory}${filename}`;
  await deps.writeAsStringAsync(fileUri, deps.json);
  return { fileUri, filename, json: deps.json };
}

export type ExportInternalDiagnosticsResult =
  | { status: 'shared'; fileUri: string; filename: string }
  | { status: 'busy' };

export async function exportInternalDiagnosticsToShare(deps: {
  cacheDirectory: string | null | undefined;
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>;
  shareAsync: (
    fileUri: string,
    options: { mimeType: string; UTI?: string; dialogTitle?: string }
  ) => Promise<void>;
  deleteAsync?: (fileUri: string) => Promise<void>;
  nowMs?: number;
}): Promise<ExportInternalDiagnosticsResult> {
  if (!isInternalDiagnosticsEnabled()) {
    throw new Error('Internal diagnostics are disabled in this build.');
  }
  if (exportInProgress) {
    return { status: 'busy' };
  }
  exportInProgress = true;
  let fileUri: string | null = null;
  try {
    const pkg = await buildInternalDiagnosticsExportPackage({
      nowMs: deps.nowMs,
    });
    const json = serializeInternalDiagnosticsExport(pkg);
    const written = await writeInternalDiagnosticsExportFile({
      json,
      cacheDirectory: deps.cacheDirectory,
      writeAsStringAsync: deps.writeAsStringAsync,
      nowMs: deps.nowMs,
    });
    fileUri = written.fileUri;
    await deps.shareAsync(written.fileUri, {
      mimeType: 'application/json',
      UTI: 'public.json',
      dialogTitle: written.filename,
    });
    return {
      status: 'shared',
      fileUri: written.fileUri,
      filename: written.filename,
    };
  } finally {
    exportInProgress = false;
    if (fileUri && deps.deleteAsync) {
      try {
        await deps.deleteAsync(fileUri);
      } catch {
        // best-effort cleanup only
      }
    }
  }
}
