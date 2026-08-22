# MERUNO Domain Boundaries V1 (M1-E)

Operational map of where analytical truth lives. Prevents Agents from inventing a second business rule in UI.

## Ownership (SSOT)

| Domain fact | Owner | Notes |
| --- | --- | --- |
| Taxonomy / spending categories | `lib/productTaxonomy.ts` | `V1_SPENDING_CATEGORIES`; uncategorized is system/review, not a spend bucket |
| Writable category boundary | `lib/productCategory.ts` | Re-exports / sanitizes against taxonomy |
| Effective item amount | `lib/receiptDiscountAllocation.ts` (`itemAmountForAnalytics`) | User override > effective > raw |
| Merchant grouping key | `lib/merchantAnalytics.ts` (`merchantAnalyticsKey`) | Prefer normalized; V1 universe = supermarket + convenience (`merchantType`) |
| Purchase occurrence | one `receipt_items` / analysis item row | Quantity is separate; do not treat qty as occurrence count |
| Product identity / family | `lib/productIdentity.ts`, `lib/productFamily.ts` | Shared by Product Detail, milestones, ShoppingIntent |
| Spec / unit normalization | `lib/productSpecification.ts` (M1-B) | purchase_quantity ≠ packCount; reliability gates comparable price |
| Price history | `lib/productPriceHistory.ts` | Reuse builder; do not cache prices on ShoppingIntent |
| JST calendar day | `lib/dateParser.ts` (`jstCalendarDayStartMs`, `jstCalendarDayKey`) | Calendar buckets only |
| Rolling time windows | `lib/rollingTimeWindow.ts` | Wall-clock N×24h cutoff; used by Analysis stats/presentation |
| Category share denominator | `calculateStats` → `categoryCompositionTotal` | Categorized merchandise only; **not** receipt.total / supportedSpend / top-N sum |
| Insights (Analysis) | `lib/buildInsights.ts` | Thresholds owned here; not a universal rule registry |
| Progressive Home milestones | `lib/engagementMilestones.ts` + `homeProgressiveExperience` | Live Home insight path |
| ShoppingIntent | `lib/shoppingIntent.ts` (+ repository/schema) | Intent ≠ purchase; resolution reuses identity/family/spec |

## Intentional Home vs Analysis differences

| Surface | Default context | Must share when inputs match |
| --- | --- | --- |
| Home (Progressive) | Short / milestone-oriented; **not** Analysis month default | Same rolling cutoff math if given same window; same taxonomy / amount / merchant / occurrence contracts |
| Analysis | Broader period (week/month/all); category bars use composition total | Same as above |

Do **not** force Home and Analysis to share the same default window.

## Display vs domain truth

- Home legacy `aggregateCategoryData` percentages may include `uncategorized` as a **display** composition slice.
- Analysis category **share** uses `categoryCompositionTotal` (excludes uncategorized).
- Do not silently mix these denominators when claiming “category share”.

## ShoppingIntent

- Reuses `resolveProductIdentity` / `productFamily` / `parseProductSpecification` / price-history targets.
- `牛奶` → family `milk` is a **shared** family alias in `productFamily`, not a Shopping-only rule.
- No Shopping-specific price formula, merchant normalize, or taxonomy.

## Dead paths removed in M1-E

- Home local `INSIGHT_RULES` / pie / unused time-range insight pipeline (not rendered; Progressive Home is live).
- `lib/homeInsightHelpers.ts` deleted as unreachable duplicate rule engine.

## Keep as V1 constants (do not “engine-ify”)

- JST timezone semantics
- Supported merchant universe (supermarket + convenience)
- Family price-normalization allowlist (C1; do not broaden here)
- Explicit min sample thresholds owned by a single rule module
- Taxonomy / classification / spec / corrections / shopping-intent contract versions

## Defer (M2 / V2)

- Generic AnalyticsResult / model registry / metric DSL
- UnitNormalizationRegistry / ProductFamilyRegistry expansion
- Broad Home↔Analysis UI metric unification beyond shared helpers
- Fuzzy merchant matching / embeddings
