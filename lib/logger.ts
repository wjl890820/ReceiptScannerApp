/**
 * Minimal logger. Warn/error feed Internal Diagnostics with a STRICT safe
 * subset only (level/tag/bounded message + genuine Error name/code).
 * Never forwards arbitrary logger payload objects as Error-like.
 */

import {
  recordDiagnosticError,
  recordDiagnosticWarning,
} from './internalDiagnostics';
import { isInternalDiagnosticsEnabled } from './internalDiagnosticsGate';
import {
  boundDiagnosticString,
  isGenuineDiagnosticError,
  normalizeDiagnosticError,
} from './internalDiagnosticsTypes';

type LogLevel = 'info' | 'warn' | 'error';

function bridgeToDiagnostics(
  level: 'warn' | 'error',
  tag: string,
  message: string,
  data?: unknown
): void {
  try {
    if (!isInternalDiagnosticsEnabled()) return;
    const safeTag = boundDiagnosticString(tag, 80);
    const safeMessage = boundDiagnosticString(message, 256);
    if (level === 'warn') {
      recordDiagnosticWarning(safeTag, safeMessage, {
        level: 'warn',
      });
      return;
    }
    // Genuine Error only — arbitrary {name, code} objects are dropped entirely.
    if (isGenuineDiagnosticError(data)) {
      const normalized = normalizeDiagnosticError(data);
      recordDiagnosticError(safeTag, safeMessage, data, {
        level: 'error',
        ...(normalized
          ? {
              errorName: normalized.name,
              ...(normalized.code !== undefined
                ? { errorCode: normalized.code }
                : {}),
            }
          : {}),
      });
      return;
    }
    recordDiagnosticError(safeTag, safeMessage, undefined, {
      level: 'error',
    });
  } catch {
    // never affect logging or app
  }
}

function log(level: LogLevel, tag: string, message: string, data?: unknown) {
  const prefix = `[${tag}]`;
  if (data !== undefined) {
    (console as any)[level](prefix, message, data);
  } else {
    (console as any)[level](prefix, message);
  }
  if (level === 'warn' || level === 'error') {
    bridgeToDiagnostics(level, tag, message, data);
  }
}

export const logger = {
  info(tag: string, message: string, data?: unknown) {
    log('info', tag, message, data);
  },
  warn(tag: string, message: string, data?: unknown) {
    log('warn', tag, message, data);
  },
  error(tag: string, message: string, data?: unknown) {
    log('error', tag, message, data);
  },
};
