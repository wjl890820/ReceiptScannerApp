# MERUNO Spec v1 (M1-B)

Concise product specification contract for V1.

## Parser version

- `parserVersion`: `meruno-spec-parser-v1`
- Changes only when parsing semantics change
- Not the app build number

## Concepts (do not conflate)

| Concept | Meaning |
| --- | --- |
| `purchase_quantity` | How many sale-line units were purchased (receipt/index layer) |
| `rawText` | Full source evidence retained for re-parse |
| `sourceText` | Matched fragment when a pattern hit |
| `sizeValue` + `sizeUnit` | Per-pack content (e.g. 500ml) |
| `packCount` | Internal multiplicity inside **one** sale unit (e.g. ×6) |
| `volumeBaseMl` / `weightBaseG` / `countBase` | Total packaged content for **one** sale unit |
| `reliability` | `exact` \| `partial` \| `unknown` |
| `dimension` | `volume` \| `weight` \| `count` \| `unknown` |

Invariant:

```
purchase_quantity ≠ packCount
```

Example:

- name `牛乳 500ml`, qty `2` → purchase_quantity=2, packCount=1, volumeBaseMl=500
- name `水 500ml×6`, qty `1` → purchase_quantity=1, packCount=6, volumeBaseMl=3000
- name `水 500ml×6`, qty `2`, lineTotal covers both → total physical ml = 2×3000

## Safe normalization

- `1L` → 1000ml
- `900mL` → 900ml
- `1.5L` → 1500ml
- `1kg` → 1000g
- `10個` → count 10

## Supported multipack (deterministic)

- `500ml×6`, `500ml x 6`, `500mL*6`
- `6×500ml`, `6 x 500ml`
- `500g×2`, `2×500g`
- `10個×2`, `2×10個`

## Ambiguous → unknown

Packaging vocabulary alone does **not** invent ml/g/count:

- `3袋×2`, `6本`, `ケース12`, `2P`, `3パック`, `12入`

`rawText` / matched evidence may still be retained.

## Price comparison

Comparable only when `reliability === 'exact'`:

- volume → ¥/L using `lineTotal / (volumeBaseMl × purchaseQuantity) × 1000`
- weight → ¥/100g
- count → ¥/item

Unknown spec may remain in purchase history but must not enter family normalized comparison.

## Persistence

- Persistent facts: receipt/user item JSON (`spec_*`, including additive `spec_raw_text`, `spec_reliability`, `spec_parser_version`)
- Derived index: rebuildable from JSON + parser
- No cloud column migration required for V1

## Historical data

Do not bulk invent multipack/spec for old rows. Insufficient evidence → unknown. Future backfill may re-parse from preserved raw names.

SSOT: `lib/productSpecification.ts`
