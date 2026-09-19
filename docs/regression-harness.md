# Meruno Receipt Regression Harness

## Snapshot Mode (Phase 1)

Command:

```bash
npm run regression:receipts -- --export /absolute/path/receipts_export_YYYYMMDD_HHmm.json
```

Optional:

```bash
--out .local/regression/report.json
--manifest-dir fixtures/regression/manifests
--fail-on-regression
```

### Snapshot Mode DOES test

- Historical export envelope / nested JSON parsing
- Baseline stage detection (`recognition_snapshot` vs `analysis_current`)
- Canonical field projection from **stored** snapshots
- Deterministic reconciliation, merchant/retailer identity, qty/price arithmetic checks
- Spec parsing + pure ProductIdentity item projection + pure index row projection
- Human-truth field grading (improvement / regression / stable / …)
- Multi-row physical receipt matching (Receipt078 / Receipt081 style)

### Snapshot Mode DOES NOT test

- Camera / image quality
- Gemini OCR accuracy
- Edge date verifier
- OCR cache behavior
- Review UI
- Persistence / DB side effects
- Repeat / PPH (deferred to Phase 2)

Do **not** treat re-running `normalizeOcrAnalysis` on an enriched snapshot as “current OCR output”. Phase 1 keeps any normalize replay experimental and out of correctness grading.

### Truth manifests

Physical Receipt073–081 live under `fixtures/regression/manifests/`.

These are **not** SampleNNN test fixtures. Omitted fields mean “not confirmed”.

### Privacy

Export files stay local and uncommitted (see `.local/regression/`, `regression-output/` in `.gitignore`). Reports redact `user_id`, `installation_id`, tokens, and local image paths.

### Exit codes

- Default: `0` even when baselines differ (visibility first)
- `--fail-on-regression`: `1` only for human-truth `REGRESSION` or harness failure

## Deep Mode (Phase 2 — Repeat / PPH)

```bash
npm run regression:receipts:deep -- \
  --export .local/regression/receipts_export_YYYYMMDD_HHmm.json \
  --out .local/regression/regression-deep-report.json
```

Chain: stored snapshots → **current item authority** (`user_items_json` → else `analysis_json`) → production `selectAnalyticsReceipts` → **canonical purchase-occurrence** (conservative complete-link + representative receipt) → Repeat / PPH / visit-spend → deep report.

- **inputMode**: `current_projection` only (v1)
- **occurrence SSOT**: `lib/canonicalPurchaseOccurrence.ts` (shared by Repeat + PPH + visit/spend representatives). HC may retain multiple ReceiptRows; representatives prevent rescan inflation of quantity/gross/visits.
- **Terminology**:
  - `storedReceiptRows` / `analyticsRetainedReceipts` / `canonicalPurchaseOccurrences` are distinct
  - Repeat `profileCount` = profiles with occurrence ≥ 2
  - PPH `targetCount` = comparison keys (not unique products)
  - rejection counts = overlapping observation-reason hits
- **observed-history diff**: not available in Phase 2 v1
- Physical 078/080/081: HC partial collapse and/or production occurrence splits
  without durable provenance are **diagnostics** (`unresolved_without_durable_provenance`),
  not automatic A-fails. Deep exits non-zero only for production-safety failures
  (value inflation inside a proven occurrence, ready with fewer than 2 points, harness failure).
- Terminology: Repeat `profileCount` = profiles with occurrence ≥ 2; PPH `targetCount` = comparison keys; rejection counts = observation-level hits
- Phase 1 CLI remains unchanged and fast
