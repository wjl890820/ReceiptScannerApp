# Merchant Domain Contract (R1-B1–B3a)

**Status:** R1-B1 frozen; R1-B2 `DerivedRetailerIdentity`; R1-B3a `RetailerProfile`; R1-B3b merchant-edit consistency.
**Scope:** No retailer/store DB tables, migrations, backfill, receipt rewrite, analytics wiring, or UI consumption of profile yet.

Analysis D production universe and duplicate fingerprints remain frozen. `merchantAnalyticsKey` outputs must stay byte-identical for existing fixtures.

---

## 1. Layers (current)

| Layer | Field / API | Role |
| --- | --- | --- |
| Observation | `merchant_raw` | Receipt / OCR / user-reviewed merchant evidence |
| Retailer-ish derived | `merchant_normalized` | Current chain-ish normalization (not a DB retailer id) |
| Derived retailer identity | `deriveRetailerIdentity(...)` | Stable chain key + optional `storeHint` (recomputable; **not** persisted) |
| **Retailer profile** | `getRetailerProfile(retailerKey)` → `RetailerProfile` | Objective descriptive metadata on a known `retailerKey` (**not** persisted; **not** analytics-wired) |
| Business format | `merchant_type` | `supermarket` \| `convenience` \| `other` \| `unknown` — **V1 eligibility only** |
| Analytics identity | `merchantAnalyticsKey(receipt)` | **Single** V1 merchant aggregation key (**unchanged**) |
| Legacy mirror | `store_raw` / `store_normalized` | Placeholder copies — **not** verified branch identity |

Pipeline (additive):

```
merchant_raw
    ↓
merchant_normalized          (existing; do not repurpose)
    ↓
DerivedRetailerIdentity      (R1-B2)
    ↓
RetailerProfile              (R1-B3a — metadata only)
    ↓
future optional verified Store / richer merchant intelligence
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

- Derived; may evolve when chain rules expand.
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
- `RetailerProfile.retailerFormat` (see §G)

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
- Do **not** introduce a second production aggregation key without an explicit migration plan.
- Do **not** use UI display strings as analytics identity.

### E. `store_raw` / `store_normalized` — LEGACY / PLACEHOLDER MIRROR

Current status: on save they mirror `merchant_raw` / `merchant_normalized` (`lib/db.ts`). Production analytics and UI do **not** treat them as verified branch/store identity. They are persisted/synced only.

Do **not**:

- treat them as real store IDs
- expose store analytics from them
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

It is **NOT** receipt Source of Truth, `merchantAnalyticsKey`, a persisted DB id, or physical store proof.

`storeHint` is parse evidence only — **not** `storeKey` / verified branch identity.

### G. `RetailerProfile` — R1-B3a descriptive metadata

SSOT: `lib/retailerProfile.ts` → `getRetailerProfile`.

```ts
type RetailerProfile = {
  retailerKey: RetailerKey;
  displayName: string;
  retailerFormat: 'supermarket' | 'convenience' | 'warehouse_club';
  membershipRequired: boolean;
  bulkPurchaseFormat: boolean;
};
```

**RetailerProfile =** stable descriptive retailer metadata.

**RetailerProfile ≠**

- `merchant_type`
- V1 eligibility
- receipt intent / stock-up behavior
- user preference or membership status
- physical-store identity
- brand / parent-company hierarchy

#### `merchant_type` vs `retailerFormat`

| Concern | Field | Example (Costco) |
| --- | --- | --- |
| V1 analytics eligibility | `merchant_type` on receipt | `supermarket` (existing contract) |
| Descriptive retailer format | `RetailerProfile.retailerFormat` | `warehouse_club` |

`retailerFormat = warehouse_club` must **not** invent `merchant_type = warehouse_club` and must **not** change `isV1SupportedReceipt` / `isV1SupportedMerchantType`.

#### `membershipRequired`

Ordinary shopping at the retailer generally requires a membership relationship as part of the retailer format.

Does **not** model the user's actual membership, tier, renewal, or card.

#### `bulkPurchaseFormat`

The retailer's business/store format is materially oriented toward bulk / large-pack purchasing.

Does **not** mean this receipt was a stock-up trip, every item was bulk, or the user prefers bulk.

Unresolved / unknown `retailerKey` → `getRetailerProfile` returns `null` (no invented profile).

Not wired into Home / Analysis / History / Product Detail / ShoppingIntent / duplicates / Analysis D in B3a.

---

## 3. UI display vs analytics identity

| Concern | Typical source | Notes |
| --- | --- | --- |
| History / Product Detail / summaries | `merchant_raw \|\| merchant_normalized` | Display may keep OCR/user spelling |
| V1 merchant spend / frequency | `merchantAnalyticsKey(...)` | Aggregation only |

Display identity and analytics identity are **intentionally different**.

---

## 4. Merchant edit consistency (R1-B3b)

When the merchant observation changes through supported edit paths
(`saveReceipt` with `reviewedSave`, or `updateReceipt` with a changed `analysis.merchant`):

1. `merchant_raw` = user-approved observation
2. `merchant_normalized` = `canonicalizeMerchantChain(merchant_raw)` (same helper as save)
3. `merchant_type` = redetected via `detectMerchantTypeFromReceipt` (ignore stale analysis type)
4. `store_raw` / `store_normalized` = placeholder mirrors of merchant_* (not physical store identity)
5. `analysis_json` merchant / merchant_normalized / merchant_type kept aligned

Non-merchant updates (note / same merchant analysis) must **not** churn merchant-derived columns.

Still open (not B3b):

1. Product Detail / price-history merchant grouping may not always align with `merchantAnalyticsKey`.

---

## 5. Future layers

```
merchant_raw
    ↓
merchant_normalized
    ↓
DerivedRetailerIdentity   (R1-B2)
    ↓
RetailerProfile           (R1-B3a — implemented, not persisted, not analytics-wired)
    ↓
future optional verified Store / richer merchant intelligence
```

- **Retailer identity ≠ store identity**
  Example: `業務スーパー古川` → `retailerKey=gyomu_super` → optional `storeHint=古川` → profile for 業務スーパー
- No `StoreProfile` / geocoding / brand hierarchy in B3a

---

## 6. Invariants (must not regress)

- Raw observation preserved (`merchant_raw` not mutated by derive / profile lookup).
- `merchant_normalized` helper outputs unchanged.
- `merchantAnalyticsKey` unchanged for existing fixtures.
- `merchant_type` / V1 eligibility unchanged by profile metadata.
- Derived identity + profile recomputable; no persistence / backfill.
- No destructive receipt rewrite / no schema or sync payload change.
- History remains historical/raw-first for display.
- Analytics receipt selection / Analysis D universe / duplicate fingerprints unchanged.
- Unsupported merchants still save; unknown retailers may stay unresolved / profile-null.
- R1-B2/B3a do not expand OCR convenience alias rules beyond existing canonical mapping.
