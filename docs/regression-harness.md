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
