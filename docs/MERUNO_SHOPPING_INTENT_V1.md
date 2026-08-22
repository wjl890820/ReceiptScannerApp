# MERUNO ShoppingIntent v1 (M1-D)

Minimum future-compatible domain foundation for shopping planning.

Contract version: `meruno-shopping-intent-v1`  
Resolution version: `meruno-shopping-resolution-v1`  
SSOT: `lib/shoppingIntent.ts` · persistence: `lib/shoppingIntentRepository.ts` · schema: `lib/shoppingIntentSchema.ts`

## Intent ≠ purchase

| Concept | Meaning |
| --- | --- |
| **Receipt / Transaction** | Something that already happened |
| **ShoppingIntent** | Something the user may want to happen |

`completed` means the user marked the intent done. It does **not** prove a matching purchase occurred.

## Layers

| Layer | Authority |
| --- | --- |
| **rawText** | Authoritative user intent text (always preserved) |
| **Derived resolution** | Optional semantic identity (family / canonical / brand) |
| **Manual resolution** | Explicit user product link (outranks derived) |

Precedence for effective identity:

```
manual resolution  >  derived resolution  >  raw text only
```

An intent may exist with unresolved semantics. Never reject save because resolution failed.

## Intent types

- `product` — resolved with enough confidence to a product concept
- `note` — free-text reminder / non-product memo
- `unknown` — unresolved; may later become product

Do not classify every string as a product.

## Status lifecycle

`active` → `completed` | `archived`

- **complete**: sets `status=completed`, `completedAt`, `updatedAt`
- **archive**: soft retention without proving purchase
- **delete**: physical local delete (distinct from archive)

No `purchased` / `in_cart` / recommendation statuses in V1.

## Family vs canonical

Resolution level:

- `family` — e.g. `牛奶` → `milk`
- `canonical` — e.g. `明治おいしい牛乳` → existing canonical identity
- `unresolved` — free text only

Generic intents (`牛奶`, `鸡蛋`, `大米`) are first-class. Canonical is not required.

Reuse existing identity / family / M1-B spec contracts. Do **not** invent `shoppingFamily` / `shoppingCanonical` / `shoppingSpec`.

## desiredQuantity ≠ purchase_quantity

`desiredQuantity` is shopping-list quantity (e.g. 牛奶 × 2).

Receipt `purchase_quantity` is a different fact. They must never share the same field semantics.

## desiredSpec / M1-B reuse

Desired package size (`牛奶 1L`, `米 5kg`) uses `parseProductSpecification` from M1-B.

If uncertain, desiredSpec remains absent / unknown. No second parser.

## Price history reuse

ShoppingIntent stores **what the user wants**, not historical prices.

Query existing `buildProductPriceHistory` / `loadProductPriceHistory` via:

```
family | canonical ProductDetailTarget
```

Do **not** persist `lastPrice` / `lowestPrice` / `averagePrice` as domain truth.

## Future purchase matching

Not implemented in M1-D. Preserve compatible keys:

- `familyKey`
- `canonicalProductName`
- `brand`
- desiredSpec dimension / size
- time proximity (future)

Raw-string equality is **not** the required matcher.

Example: intent `牛奶` may later match purchase `明治おいしい牛乳 900ml` via `family=milk`.

## Privacy

ShoppingIntent is private planning data.

Do not emit `rawText`, resolved product, brand, or desired quantity into Product Analytics payloads.

`stripShoppingIntentForAnalyticsExport` keeps only non-content metadata.

## Local / cloud durability

**Decision: LOCAL-ONLY FOR V1 FOUNDATION.**

- Additive SQLite table `shopping_intents` in `receipts_v2.db`
- No new outbox type, sync conflict rules, or restore worker changes
- Data Foundation P0 remains closed

Future cloud ownership / list grouping / reminders may be additive migrations.

## Ordering

List default: `updated_at DESC`, then `created_at DESC`, then `id ASC`.  
No drag-and-drop in M1-D.

## Migration safety

Additive `CREATE TABLE IF NOT EXISTS` only. No receipt table semantic changes. No production mutation.
