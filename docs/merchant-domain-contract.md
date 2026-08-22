# Merchant Domain Contract (R1-B1 freeze + R1-B2 derived retailer identity)

**Status:** R1-B1 frozen; R1-B2 adds recomputable `DerivedRetailerIdentity` only.
**Scope:** No retailer/store DB tables, migrations, backfill, receipt rewrite, or analytics wiring of `retailerKey`.

Analysis D production universe and duplicate fingerprints remain frozen. `merchantAnalyticsKey` outputs must stay byte-identical for existing fixtures.

---

## 1. Layers (current)

| Layer | Field / API | Role |
| --- | --- | --- |
| Observation | `merchant_raw` | Receipt / OCR / user-reviewed merchant evidence |
| Retailer-ish derived | `merchant_normalized` | Current chain-ish normalization (not a DB retailer id) |
| **Derived retailer identity** | `deriveRetailerIdentity(...)` → `DerivedRetailerIdentity` | Stable chain key + optional `storeHint` (recomputable; **not** persisted) |
| Business format | `merchant_type` | `supermarket` \| `convenience` \| `other` \| `unknown` |
| Analytics identity | `merchantAnalyticsKey(receipt)` | **Single** V1 merchant aggregation key (**unchanged** by R1-B2) |
| Legacy mirror | `store_raw` / `store_normalized` | Placeholder copies of merchant fields — **not** verified branch identity |

Pipeline (additive):

```
merchant_raw
    ↓
merchant_normalized          (existing; do not repurpose)
    ↓
DerivedRetailerIdentity      (R1-B2 — deriveRetailerIdentity)
    ↓
future optional verified Store   (not implemented)
```

---

## 2. Field contracts

### A. `merchant_raw` — Merchant Observation

Meaning: what the receipt/OCR (or user review) says about the merchant.

Rules:

- Historical / raw evidence.
- Must **not** be overwritten by derived normalization.
- User review may update the user-approved observation.
- Derived identities must remain recomputable from it (plus frozen rules).

### B. `merchant_normalized` — Current retailer-ish identity

Meaning: derived canonical merchant/chain representation used for persistence and analytics preference.

Rules:

- Derived; may evolve when R1-B2 expands chain rules.
- **Not** guaranteed physical store identity.
- **Not** a durable retailer database primary key.
- Prefer this over raw when building `merchantAnalyticsKey`.

### C. `merchant_type` — Business format (V1 support input)

Values: `supermarket` | `convenience` | `other` | `unknown`

Meaning: business-format classification used by V1 shopping-analytics eligibility.

It is **not**:

- product category
- shopping intent
- physical store identity
- retailer ID

V1 eligibility (`isV1SupportedReceipt` / `isV1SupportedMerchantType`):

| type | V1 supported |
| --- | --- |
| supermarket | yes |
| convenience | yes |
| other | no |
| unknown | no |

Unsupported receipts remain valid saved records; they are only excluded from the V1 shopping analytics universe.

`merchant_type` is **not** a generic grocery boolean. Convenience is V1-supported even when legacy grocery detectors treat convenience as non-supermarket.

### D. `merchantAnalyticsKey` — Sole V1 aggregation identity

Implementation SSOT: `lib/merchantAnalytics.ts` → `merchantAnalyticsKey`.

```
merchantAnalyticsKey(receipt) =
  normalizeMerchantName(merchant_normalized || merchant_raw || '')
```

Rules:

- Prefer `merchant_normalized`, then `merchant_raw`, then empty.
- Always run through `normalizeMerchantName` (light cleanup only).
- Do **not** introduce a second production aggregation key in R1-B1/B2 without an explicit migration plan.
- Do **not** use UI display strings as analytics identity.

### E. `store_raw` / `store_normalized` — LEGACY / PLACEHOLDER MIRROR

Current status: on save they mirror `merchant_raw` / `merchant_normalized` (`lib/db.ts`). Production analytics and UI do **not** treat them as verified branch/store identity. They are persisted/synced only.

Do **not**:

- treat them as real store IDs
- expose store analytics from them
- rename/delete/migrate them in R1-B1
- invent branch extraction here

### F. `DerivedRetailerIdentity` — R1-B2 recomputable metadata

SSOT: `lib/retailerIdentity.ts` → `deriveRetailerIdentity`.

```ts
type DerivedRetailerIdentity = {
  retailerKey: string | null;
  retailerDisplayName: string | null;
  storeHint: string | null; // optional parse residue only
  source: 'known_retailer_rule' | 'existing_normalized' | 'unresolved';
  confidence: 'exact' | 'derived' | 'unknown';
};
```

It **is**:

- deterministic, rebuildable from `merchant_raw` / `merchant_normalized`
- derived from an explicit registry + reuse of existing `canonicalizeMerchantChain` / `normalizeMerchant` evidence
- independent of UI language for `retailerKey` where practical (`costco`, `gyomu_super`, …)

It is **NOT**:

- receipt Source of Truth
- a replacement for `merchantAnalyticsKey`
- a persisted retailer DB ID / UUID
- physical store proof
- wired into Home / Analysis / duplicates / price history / Product Detail / ShoppingIntent (R1-B2)

`storeHint`:

- optional residue after removing a known chain prefix (e.g. `業務スーパー古川` → `古川`)
- **not** `storeKey`, **not** verified branch identity
- must **not** be persisted, geocoded, or merged across receipts in R1-B2

Unknown / independent merchants may remain `retailerKey: null` (`source: 'unresolved'`). Do not force `normalizeMerchantName(any merchant)` into a retailer key.

---

## 3. UI display vs analytics identity

| Concern | Typical source | Notes |
| --- | --- | --- |
| History / Product Detail / summaries | `merchant_raw \|\| merchant_normalized` | Display may keep OCR/user spelling |
| V1 merchant spend / frequency | `merchantAnalyticsKey(...)` | Aggregation only |

Display identity and analytics identity are **intentionally different**. Do not “fix” History by replacing raw display with analytics keys in R1-B1.

---

## 4. Known follow-up

**Product Detail / price-history grouping** may still use SQL `COALESCE(merchant_normalized, merchant_raw)` without `merchantAnalyticsKey` / `normalizeMerchantName`.

→ Tracked for **R1-B3** (RetailerProfile / consumption). Do not change Product Detail or analytics aggregation in B2.

---

## 5. Future layers

```
merchant_raw
    ↓
merchant_normalized
    ↓
DerivedRetailerIdentity   (R1-B2 — implemented, not persisted, not analytics-wired)
    ↓
optional verified Store   (later; storeHint is only parse evidence)
```

- **Retailer identity ≠ store identity**
  Example: `業務スーパー古川` → `retailerKey=gyomu_super` → optional `storeHint=古川`
- **RetailerProfile** (R1-B3+) = objective metadata on retailer identity
  It does **not** replace `merchant_type` or V1 eligibility.

---

## 6. Invariants (must not regress)

- Raw observation preserved (`merchant_raw` not mutated by derive).
- `merchant_normalized` semantics / outputs unchanged by R1-B2 (no rewrite of existing helpers).
- `merchantAnalyticsKey` unchanged for existing fixtures.
- Derived retailer identity recomputable; no persistence / backfill.
- User override > machine-derived observation when reviewed.
- No destructive receipt rewrite / no schema or sync payload change in B1/B2.
- History remains historical/raw-first for display.
- Analytics receipt selection / Analysis D universe / duplicate fingerprints unchanged.
- Unsupported merchants still save; unknown retailers may stay unresolved.
- R1-B2 does not expand OCR convenience alias rules beyond mapping existing canonicals.
