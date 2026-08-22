# Merchant Domain Contract (R1-B1 freeze)

**Status:** Frozen for R1-B1.  
**Scope:** Documentation + regression locks only. No new retailer/store tables, migrations, or normalization-rule expansion.

Analysis D production universe and duplicate fingerprints remain frozen unless a future change proves byte-identical merchant-key outputs.

---

## 1. Layers (current)

| Layer | Field / API | Role |
| --- | --- | --- |
| Observation | `merchant_raw` | Receipt / OCR / user-reviewed merchant evidence |
| Retailer-ish derived | `merchant_normalized` | Current chain-ish normalization (not a DB retailer id) |
| Business format | `merchant_type` | `supermarket` \| `convenience` \| `other` \| `unknown` |
| Analytics identity | `merchantAnalyticsKey(receipt)` | **Single** V1 merchant aggregation key |
| Legacy mirror | `store_raw` / `store_normalized` | Placeholder copies of merchant fields — **not** verified branch identity |

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

---

## 3. UI display vs analytics identity

| Concern | Typical source | Notes |
| --- | --- | --- |
| History / Product Detail / summaries | `merchant_raw \|\| merchant_normalized` | Display may keep OCR/user spelling |
| V1 merchant spend / frequency | `merchantAnalyticsKey(...)` | Aggregation only |

Display identity and analytics identity are **intentionally different**. Do not “fix” History by replacing raw display with analytics keys in R1-B1.

---

## 4. Known follow-up (do not fix in R1-B1)

**Product Detail / price-history grouping** may still use SQL `COALESCE(merchant_normalized, merchant_raw)` without `merchantAnalyticsKey` / `normalizeMerchantName`.

→ Tracked for **R1-B3** after retailer normalization (R1-B2) is stable. Do not change Product Detail results in B1.

---

## 5. Intended future layers (not implemented in B1)

```
merchant_raw
    ↓
derived retailer identity   (chain / business — R1-B2+)
    ↓
optional derived store identity  (branch — later)
```

- **Retailer identity ≠ store identity**  
  Example (semantic only, not implemented):  
  `業務スーパー古川` → retailer `業務スーパー` → possible store `古川`
- **RetailerProfile** (future) = small objective metadata attached to retailer identity  
  (display name, format, membership/warehouse flags, etc.)  
  It does **not** replace `merchant_type` or V1 eligibility.

---

## 6. Invariants (must not regress)

- Raw observation preserved.
- Derived values recomputable.
- User override > machine-derived observation when reviewed.
- No destructive receipt rewrite / no B1 schema or sync payload change.
- History remains historical/raw-first for display.
- Analytics receipt selection / Analysis D universe / duplicate fingerprints unchanged by this contract freeze.
- Unsupported merchants still save.
- R1-B1 does not add/remove/change chain alias or merchant-type heuristics.
