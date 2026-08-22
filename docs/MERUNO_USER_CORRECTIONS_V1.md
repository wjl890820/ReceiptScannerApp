# MERUNO User Corrections v1 (M1-C)

Minimum future-compatible contract for explicit user corrections.

Contract version: `meruno-user-corrections-v1`  
SSOT: `lib/userCorrections.ts`

## Layers

| Layer | Meaning | Mutate on user edit? |
| --- | --- | --- |
| **RAW** | OCR / recognition snapshot evidence | **Never** |
| **DERIVED** | Machine semantics (category, identity, parsed spec, discount allocation) | May recompute when not user-owned |
| **USER OVERRIDE** | Current effective value for UI / analytics | Yes — highest priority |
| **CORRECTION PROVENANCE** | Before → after evidence of explicit edits | Append-only; never invent |

## Precedence

```
USER OVERRIDE  >  DERIVED MACHINE VALUE  >  RAW FALLBACK
```

Correction provenance explains *how* the override came to exist. It does not replace the effective value store (`user_items_json` / reviewed analysis fields).

## Correction event (conceptual)

```ts
{
  field,                 // e.g. item_amount | item_category | merchant
  originalValue,         // value being replaced (effective before this edit)
  correctedValue,        // explicit user value
  correctedAt,           // UTC ISO-8601 of this field correction
  source: "user",
  originalSource?,       // ocr | machine | user | unknown | legacy_unavailable
  previousClassificationSource?,
  previousClassificationVersion?,
  taxonomyVersion?,
  itemSourceIndex?,
  contractVersion: "meruno-user-corrections-v1"
}
```

## Storage

- Additive `user_corrections: UserCorrectionEvent[]` on:
  - item objects inside `user_items_json` / `analysis_json.items`
  - optional receipt root inside `analysis_json` (merchant / date / total / tax / note)
- Survives existing cloud backup/restore of those JSON columns
- **No** new Supabase columns for V1
- `receipt_items` index remains derived; rebuild must not erase user JSON overrides or correction arrays

## Repeated edits

Append-only within the durable host:

- `69 → 70` then `70 → 72` → **two** events; effective value = `72`
- First machine/raw origin remains reconstructable from the earliest `originalValue` / RAW snapshot
- Do **not** collapse history to `69 → 72` only

## Field coverage (V1 editable surfaces)

| Field | Editable UI | RAW preserved in |
| --- | --- | --- |
| `item_category` | History detail + Scan review | prior classification_* + analysis when user_items override |
| `item_amount` | History detail + Scan review | recognition / analysis amounts |
| `item_quantity` | History detail + Scan review | recognition / analysis qty |
| `item_name` | Scan review only | `ocr_recognized_name` / recognition snapshot |
| `merchant` | Scan review only | recognition snapshot merchant |
| `transaction_date` | Scan review only | recognition snapshot date |
| `receipt_total` | Scan review only | recognition / prior analysis total |
| `receipt_tax` | Scan review only | recognition / prior analysis tax |
| `receipt_note` | Scan review only | prior note if any |
| `item_spec` | **Not** user-editable today | future: raw vs machine vs user layers |

History detail does **not** edit merchant / date / receipt total / item name.

## Category corrections

Record before category + prior `classification_source` / `classification_version` / `taxonomy_version`.  
After: `classification_source=user`, `classification_version=null` (M1-A).  
Backfill / rebuild must not overwrite explicit user category.

## Amount corrections (Phase B)

Example: OCR `69` → user `70`

- RAW stays `69`
- Effective override / analytics = `70` (`amountUserEdited`, `itemAmountForAnalytics`)
- Provenance records `69 → 70`
- Does **not** create a new purchase occurrence

## Name corrections & identity

User rename may invalidate classifier identity evidence. Scan-review re-resolves identity when the final name differs from the snapshot name (`useExistingClassificationEvidence` only when names match). Do not invent a new identity engine here.

## Spec readiness (no UI)

Conceptual layers only: raw spec text → machine parsed spec (M1-B) → future user corrected spec. No unused UI in V1.

## Legacy edits

Rows with `amountUserEdited` / `classification_source=user` but no `user_corrections`:

- status = `legacy_unavailable`
- Do **not** fabricate before/after values
- Effective override still wins

## Privacy

Correction provenance is private domain data (may include item/merchant names).

- Keep with the user's receipt/account JSON
- Do **not** emit raw correction contents to Product Analytics
- Future model-training / aggregate use needs separate consent policy

## Future supervision (not built now)

Contract must later support queries such as:

- category corrections by previous classifier version
- amount OCR correction frequency
- merchant / item-name correction patterns
- correction rate by field

without reconstructing history from overwritten finals only.
