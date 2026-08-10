#!/usr/bin/env node
/**
 * Minimal receipt replay harness (Phase 1 skeleton).
 *
 * Loads JSON fixtures from a directory and prints telemetry schema.
 * Does NOT fabricate benchmark accuracy — requires real fixture files.
 *
 * Usage:
 *   node tools/replay_receipts.js [fixtureDir]
 *
 * Default fixture dir: fixtures/receipts/
 */

const fs = require('fs');
const path = require('path');

const FIXTURE_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'fixtures', 'receipts');

const TELEMETRY_SCHEMA = {
  item_count: 'number',
  local_classified_count: 'number',
  local_uncategorized_count: 'number',
  batch_ai_enabled: 'boolean',
  batch_ai_called: 'boolean',
  batch_ai_item_count: 'number',
  batch_ai_applied_count: 'number',
  batch_ai_suggested_count: 'number',
  final_uncategorized_count: 'number',
  classification_duration_ms: 'number',
  batch_ai_duration_ms: 'number (optional)',
};

function main() {
  if (!fs.existsSync(FIXTURE_DIR)) {
    console.error('[replay:receipts] Fixture directory not found:', FIXTURE_DIR);
    console.error('');
    console.error('Create fixture JSON files under fixtures/receipts/ to replay.');
    console.error('Each file should contain a receipt analysis object (items, merchant, etc.).');
    console.error('');
    console.error('Expected classification telemetry schema (from enricher):');
    console.error(JSON.stringify(TELEMETRY_SCHEMA, null, 2));
    process.exit(1);
  }

  const files = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    console.error('[replay:receipts] No .json fixtures in:', FIXTURE_DIR);
    console.error('Add receipt fixture JSON files and retry.');
    process.exit(1);
  }

  console.log('[replay:receipts] Found', files.length, 'fixture(s) in', FIXTURE_DIR);
  console.log('[replay:receipts] Telemetry schema:', JSON.stringify(TELEMETRY_SCHEMA, null, 2));

  for (const file of files) {
    const full = path.join(FIXTURE_DIR, file);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const data = JSON.parse(raw);
      const itemCount = Array.isArray(data?.items) ? data.items.length : 0;
      console.log(' -', file, '| merchant:', data?.merchant ?? '(none)', '| items:', itemCount);
    } catch (e) {
      console.warn(' -', file, '| parse error:', e.message);
    }
  }

  console.log('');
  console.log('[replay:receipts] Full pipeline replay not wired in Phase 1.');
  console.log('[replay:receipts] Use lib/receiptEnricher tests + manual scan for validation.');
}

main();
