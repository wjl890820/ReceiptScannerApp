# MERUNO Analysis D — Real-Data Value Validation

Read-only validation harness for deciding whether V1 Analysis delivers useful value on a real device with real receipt history.

## Purpose

Analysis D answers:

> When a user has accumulated a meaningful receipt history, does MERUNO actually tell them useful things?

D0 builds the diagnostic report generator and fixtures.  
D1 runs it on-device against real local data and assigns a human verdict.

This is **not** primarily a correctness-refactor phase. Analytical contracts were frozen in B / C1 / C2 / M1. D0 observes; it does not rewrite formulas.

## Read-only rule

`buildAnalysisDReport` in `lib/analysisDReport.ts` is an **observer**:

- Reuses production domain functions (stats, taxonomy, merchants, identity, spec, price history, insights, corrections).
- Does **not** write receipts, items, shopping intents, outbox, or Supabase.
- Does **not** backfill, reclassify, or invent second analytics implementations.
- Finding an apparent product bug → **report it**; do not silently change thresholds or semantics during D0/D1 review.

## Report fields

Structured type: `AnalysisDReport` (`lib/analysisDReport.ts`).

| Field | Role |
| --- | --- |
| `contractVersion` / `generatedAt` | Report identity |
| `privacy` | Local-only contract flags (`localOnly`, `autoUpload`, `productAnalytics`, `supabaseTelemetry`) |
| `dataset` | Receipt counts, date range, merchants, item rows, date validity, supported spend |
| `categoryCoverage` | Classified vs eligible occurrence/amount rates; `coverageDenominator = 'eligible_item_effective_amount'` (never `receipt.total`) |
| `categoryValue` | Per window (`7d` / `30d` / `all`) composition, shares, top category |
| `merchants` | Top merchants + grouping coverage |
| `frequentProducts` | Frequent groups + unresolved identity rates |
| `identityCoverage` | normalized / canonical / family / brand / spec reliability |
| `specCoverage` | volume/weight/count exact, unknown, multipack, raw-without-comparable |
| `priceCoverage` | SKU vs family-normalized eligibility, group observation counts, suppression reasons |
| `priceHistoryExamples` | Small representative family examples (no cheap/expensive labels) |
| `trends` | Matched-period sample sizes, eligibility, suppression reason |
| `insights` | Emitted Analysis + Home progressive/milestone rows; review slot left null for human D1 labeling |
| `corrections` | M1-C correction event counts by field (`privacy: 'local_diagnostic_only'`) |
| `dataQualityFlags` | Non-mutating suspicion flags |
| `crossSurfaceParity` | Same receipts + same window → shared metric identity |
| `smartShoppingReadiness` | Evidence-density hint only (no Shopping UI evaluation) |

Helpers:

- `serializeAnalysisDReport` — key-sorted JSON + trailing newline
- `formatAnalysisDReportSummary` — concise human summary
- `occurrenceCountIgnoringQuantity` — documents occurrence = row

## Privacy boundary

The report contains private consumption data. Guarantees:

- local by default (`privacy.localOnly === true`)
- never auto-upload
- never enter Product Analytics
- never sent to Supabase as telemetry
- correction profile marked `local_diagnostic_only`

D1 may allow **manual** JSON share only when diagnostics are explicitly enabled.

## Finding taxonomy (D1 manual classification)

Every finding must be labeled before any fix:

| Label | Meaning |
| --- | --- |
| **CORRECTNESS BUG** | Calculation contradicts a frozen contract |
| **DATA COVERAGE GAP** | Contract is correct; insufficient reliable data |
| **TAXONOMY / IDENTITY GAP** | Product semantics too weak for useful output |
| **VALUE GAP** | Output is correct but not useful |
| **UI / PRESENTATION GAP** | Underlying value is useful but displayed poorly |
| **EXPECTED SUPPRESSION** | Correctly silent due to low/reliable-sample gate |
| **DEFER** | Not required for V1 |

## D1 checklist (14 user-value questions)

1. Can the user immediately understand how much they spent?
2. Can they understand where the money went?
3. Are top merchants accurate and useful?
4. Do frequent products feel like actual repeated purchases?
5. Is product identity coverage high enough for the feature to matter?
6. Does price history contain enough repeated products to be useful?
7. Are normalized prices trustworthy when shown?
8. Are unavailable normalized comparisons correctly suppressed?
9. Do trends say something meaningful rather than mathematical noise?
10. Are low-sample situations quiet?
11. Are Insights useful beyond simply repeating the chart?
12. Does the app surface at least some facts the user would not easily know from memory?
13. Does accumulated receipt data create increasing value over time?
14. Does current data quality appear sufficient for future Smart Shopping?

## PASS / CONDITIONAL PASS / FAIL

Assigned only after real-device / real-data review. No hard product thresholds in D0.

| Verdict | Meaning |
| --- | --- |
| **PASS** | V1 Analysis delivers useful value; only minor presentation fixes needed |
| **CONDITIONAL PASS** | Core value exists, but specific coverage/correctness issues must be fixed before UI polish |
| **FAIL** | Current Analysis is mostly noise/insufficient and needs product-logic revision |

## D1-A on-device access (implemented)

- Flag: `ENABLE_ANALYSIS_D_DIAGNOSTICS` (also `EXPO_PUBLIC_ENABLE_ANALYSIS_D_DIAGNOSTICS` / Expo `extra` in `app.config.js`)
- Gate: `isAnalysisDDiagnosticsEnabled()` in `lib/env.ts`
- **Default OFF**
- When ON (validation build only):
  - Settings → **Internal / Validation** → **Analysis D Diagnostics**
  - Screen: `app/analysis-d-diagnostics.tsx`
  - Generate / refresh via `generateAnalysisDDiagnosticsBundle()` → D0 `buildAnalysisDReport` + D2-A duplicate audit
  - Concise summary + manual JSON share (`analysis-d-report-YYYYMMDD-HHmmss.json`)
  - JSON export may nest `{ report, duplicateScanAudit }` when D2-A audit is present
- No permanent debug menu
- No auto-upload / Supabase / telemetry
- Read-only: no receipt / correction / outbox / cloud writes
- No Shopping UI / Product Analytics / OCR / Data Foundation changes

## D2-A duplicate / re-scan audit (implemented — audit only)

Domain freeze: **Stored Receipt Record ≠ Unique Real-World Purchase**.

- Module: `lib/analysisDDuplicateAudit.ts`
- Exact fingerprint (deterministic, no fuzzy): merchant key + `transaction_at` + total + tax slot + ordered `(nameCanonical, qty, lineAmount)`
- Independent of receipt DB id and `created_at`
- Missing / invalid `transaction_at` → never exact or probable dedupe
- Probable groups are **diagnostic-only** (structural match with different name canonicals)
- Impact: before vs exact-deduped via production `buildAnalysisDReport` only — **does not change V1 production formulas**
- No delete / merge / rewrite / tombstone / UI / Transaction entity
- Recommended V1 policy: **B_EXCLUDE_EXACT_ONLY** when exact precision remains high; do **not** adopt C without evidence
- Category conservation gap (composition denominator vs active rows) is **independent** of duplicate scans → D2-B
- Frequent-product SKU fallback remains blocked until this audit is complete
