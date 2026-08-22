# MERUNO Taxonomy v1 (M1-A)

Concise domain contract for category semantics and classification provenance.

## Taxonomy version

- `taxonomy_version`: `meruno-taxonomy-v1`
- Changes only when category **semantics / schema meaning** changes.
- Not the app build number.

## V1 spending categories (user-visible)

1. `food_ingredients`
2. `ready_to_eat`
3. `snacks_drinks`
4. `household`
5. `personal_care`
6. `pet_care`
7. `other`

## System / review state

- `uncategorized` = unresolved / unknown / needs review
- Not a normal spending category
- Excluded from Analysis category-composition denominator (Phase B)

## Semantic separation (freeze)

| Field | Meaning |
| --- | --- |
| `category` | Consumer spending bucket |
| `subcategory` | Optional finer semantic grouping (future; null today) |
| `productType` | What kind of thing the product is (future; null today) |
| `family` | Grouping / comparison identity |
| `canonical` | Specific recognized product |
| `spec` | Configuration / size attributes |

Do not conflate top-level category with product ontology.

## Classification provenance

Persisted on item JSON (analysis / user items), additive:

- `classification_source` — e.g. `alias`, `dictionary`, `mapping`, `rules`, `name_rule`, `ai`, `ai_batch`, `fallback`, `user`, `backfill`, `migration`, `unknown`
- `classification_version` — classifier/rule-set id (`meruno-classify-rules-v1`); `null` for user overrides
- `taxonomy_version` — `meruno-taxonomy-v1`

### Historical fallback

- Missing `taxonomy_version` → `meruno-taxonomy-v1` (same key space)
- Missing `classification_version` → `legacy_unknown`
- Do not invent exact historical classifier versions
- Do not mass-reclassify only to fill metadata

### Persistence decision

- **Primary SoT:** item fields inside receipt JSON (`analysis_json` / `user_items_json`)
- Cloud backup already stores that JSON → **no cloud column migration for V1**
- `receipt_items` index remains derived; no required provenance columns for V1 durability

## User override precedence

```
explicit user category override  >  machine-derived category
```

No backfill / index rebuild / classifier rerun / taxonomy migration may silently overwrite an explicit user category correction (`classification_source === 'user'`).

SSOT module: `lib/productTaxonomy.ts`.
