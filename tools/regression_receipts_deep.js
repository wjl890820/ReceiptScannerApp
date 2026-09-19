#!/usr/bin/env node
/**
 * Offline deep receipt regression CLI (Phase 2 — Repeat / PPH).
 *
 * Usage:
 *   npm run regression:receipts:deep -- --export /abs/path/receipts_export.json
 *   npm run regression:receipts:deep -- --export ./export.json --out .local/regression/regression-deep-report.json
 *
 * No network. No OCR. No DB mutation. No ProductIdentity persistence.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const root = path.join(__dirname, '..');

function shouldStubPackage(request) {
  if (request === 'expo-sqlite') return true;
  if (request === 'expo-constants') return true;
  if (request === 'expo-modules-core') return true;
  if (request === 'expo-file-system') return true;
  if (request === 'expo-secure-store') return true;
  if (request === 'expo-crypto') return true;
  if (request === 'expo-application') return true;
  if (request === 'react-native') return true;
  if (request === '@supabase/supabase-js') return true;
  if (request === '@react-native-async-storage/async-storage') return true;
  if (request.startsWith('expo-')) return true;
  return false;
}

function registerTsLoader() {
  const stubPath = path.join(__dirname, '_mock_expo_runtime.js');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (shouldStubPackage(request)) {
      return stubPath;
    }
    if (request.startsWith('@/')) {
      request = path.join(root, request.slice(2));
    }
    return origResolve.call(this, request, parent, isMain, options);
  };

  const origLoad = Module._extensions['.js'];
  function compileTs(module, filename) {
    if (filename.includes(`${path.sep}node_modules${path.sep}`)) {
      throw new Error(
        `[regression:receipts:deep] Refusing to compile node_modules TypeScript: ${filename}`
      );
    }
    const source = fs.readFileSync(filename, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
        strict: false,
      },
      fileName: filename,
    });
    module._compile(outputText, filename);
  }
  Module._extensions['.ts'] = compileTs;
  Module._extensions['.tsx'] = compileTs;
  Module._extensions['.js'] = origLoad;
}

function parseArgs(argv) {
  const out = {
    exportPath: null,
    outPath: null,
    manifestDir: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--export') out.exportPath = argv[++i];
    else if (a === '--out') out.outPath = argv[++i];
    else if (a === '--manifest-dir') out.manifestDir = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.exportPath) {
    console.log(`Meruno Deep Receipt Regression (Phase 2 — Repeat / PPH)

Usage:
  npm run regression:receipts:deep -- --export <path-to-receipts_export.json>
  optional:
    --out <report.json>
    --manifest-dir <dir>

Phase 1 remains:
  npm run regression:receipts -- --export <path>

Does NOT test OCR / camera / Edge / network / DB mutation.
`);
    process.exit(args.exportPath ? 0 : 1);
  }

  const exportPath = path.resolve(args.exportPath);
  if (!fs.existsSync(exportPath)) {
    console.error(
      '[regression:receipts:deep] Export file not found:',
      exportPath
    );
    process.exit(1);
  }

  registerTsLoader();

  const { runDeepRegressionHarness } = require('../lib/regression/runDeepHarness.ts');
  const {
    formatDeepConsoleSummary,
  } = require('../lib/regression/deepConsoleSummary.ts');
  const { resolveDeepExitCode } = require('../lib/regression/deepExitCode.ts');

  let report = null;
  let harnessFailed = false;
  try {
    report = runDeepRegressionHarness({
      exportPath,
      manifestDir: args.manifestDir || undefined,
    });
  } catch (e) {
    harnessFailed = true;
    console.error(
      '[regression:receipts:deep] Harness failed:',
      e instanceof Error ? e.message : e
    );
    if (e && e.stack) console.error(e.stack);
  }

  if (report) {
    console.log(formatDeepConsoleSummary(report));
    const outPath = args.outPath
      ? path.resolve(args.outPath)
      : path.join(
          process.cwd(),
          '.local',
          'regression',
          'regression-deep-report.json'
        );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log('');
    console.log('Wrote', outPath);
  }

  const code = resolveDeepExitCode({
    harnessFailed,
    report,
  });
  process.exit(code);
}

main();
