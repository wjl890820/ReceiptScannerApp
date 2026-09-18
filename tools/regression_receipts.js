#!/usr/bin/env node
/**
 * Offline snapshot regression CLI (Phase 1).
 *
 * Usage:
 *   npm run regression:receipts -- --export /abs/path/receipts_export.json
 *   npm run regression:receipts -- --export ./export.json --out .local/regression/report.json
 *   npm run regression:receipts -- --export ./export.json --fail-on-regression
 *
 * No network. No OCR. No DB mutation.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const root = path.join(__dirname, '..');

/** Transpile and load a .ts module from lib/ (and its relative .ts imports). */
function registerTsLoader() {
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request.startsWith('@/')) {
      request = path.join(root, request.slice(2));
    }
    return origResolve.call(this, request, parent, isMain, options);
  };

  const origLoad = Module._extensions['.js'];
  function compileTs(module, filename) {
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
  // Keep .js
  Module._extensions['.js'] = origLoad;
}

function parseArgs(argv) {
  const out = {
    exportPath: null,
    outPath: null,
    manifestDir: null,
    failOnRegression: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--export') out.exportPath = argv[++i];
    else if (a === '--out') out.outPath = argv[++i];
    else if (a === '--manifest-dir') out.manifestDir = argv[++i];
    else if (a === '--fail-on-regression') out.failOnRegression = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.exportPath) {
    console.log(`Meruno Receipt Regression (Phase 1 — offline snapshot)

Usage:
  npm run regression:receipts -- --export <path-to-receipts_export.json>
  optional:
    --out <report.json>
    --manifest-dir <dir>
    --fail-on-regression

Does NOT test OCR / camera / Edge / cache.
`);
    process.exit(args.exportPath ? 0 : 1);
  }

  const exportPath = path.resolve(args.exportPath);
  if (!fs.existsSync(exportPath)) {
    console.error('[regression:receipts] Export file not found:', exportPath);
    process.exit(1);
  }

  registerTsLoader();

  const { runRegressionHarness } = require('../lib/regression/runHarness.ts');
  const { formatConsoleSummary } = require('../lib/regression/consoleSummary.ts');
  const { resolveExitCode } = require('../lib/regression/exitCode.ts');

  let report = null;
  let harnessFailed = false;
  try {
    report = runRegressionHarness({
      exportPath,
      manifestDir: args.manifestDir || undefined,
      failOnRegression: args.failOnRegression,
    });
  } catch (e) {
    harnessFailed = true;
    console.error(
      '[regression:receipts] Harness failed:',
      e instanceof Error ? e.message : e
    );
    if (e && e.stack) console.error(e.stack);
  }

  if (report) {
    console.log(formatConsoleSummary(report));
    const outPath = args.outPath
      ? path.resolve(args.outPath)
      : path.join(process.cwd(), '.local', 'regression', 'report.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log('');
    console.log('Wrote', outPath);
  }

  const code = resolveExitCode({
    failOnRegression: args.failOnRegression,
    harnessFailed,
    report,
  });
  process.exit(code);
}

main();
