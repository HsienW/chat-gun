# Knowledge corpus kb-v1 (synthetic)

**This corpus is synthetic.** Every product, price, policy and FAQ was invented for evaluating the
X42 retrieval pipeline. Nothing here describes a real business, and figures measured on it show
method efficacy on a controlled dataset, not production performance.

## Provenance

| Field | Value |
|---|---|
| Corpus version | `kb-v1` |
| Generated | 2026-10-23 |
| Generator | `backend/scripts/knowledge/generate-synthetic-corpus.ts` (seed 42, deterministic) |
| Policy and FAQ text | `backend/scripts/knowledge/policy-documents.ts` |
| Language | English |
| Regenerate | `npm run knowledge:corpus` (from `backend/`) |

Every raw record carries a provenance header (`synthetic: true`, `corpusVersion`, `generatedAt`,
`sourceId`, `sourceType`). The ingestion pipeline rejects any source without it.

## Raw inputs

- `raw/products.json`: 212 product records across 8 categories (headphones, smartwatches, backpacks,
  running shoes, coffee makers, desk lamps, phone cases, yoga mats). The raw feed deliberately
  contains 8 exact duplicates and 4 formatting-only duplicates (case changes, doubled spaces,
  HTML entities, trailing blank lines) so cleaning is measurable.
- `raw/policies/*.md`: 20 after-sales policies and 10 FAQ documents with YAML front matter.
- `manifest.json`: generator seed and counts.

## Data preparation

`prepareCorpus` in `backend/src/knowledge/corpus.ts` runs these steps before any embedding call:

1. **Parse**: products from JSON, policies and FAQs from Markdown front matter.
2. **Provenance check**: reject records without the synthetic provenance header (`KB_SOURCE_PROVENANCE_MISSING`).
3. **Normalize**: Unicode NFKC, decode HTML entities, collapse whitespace inside paragraphs, keep paragraph breaks.
4. **Validate**: reject empty sources (`KB_SOURCE_EMPTY`) and sources over 200,000 characters (`KB_SOURCE_TOO_LARGE`).
5. **Deduplicate**: per `sourceId`, compare case-insensitive normalized title and body. Identical
   records are dropped; records with the same id but different content are counted as conflicts and
   only the first is kept.
6. **Chunk** (policy `kb-chunk-v1`): pack paragraphs up to 900 characters; split longer paragraphs on
   sentence boundaries with 120 characters of overlap. Each chunk is prefixed with its source title.

### Counts (verified by `src/knowledge/corpus.test.ts`)

| Stage | Count |
|---|---|
| Raw records (212 products + 30 documents) | 242 |
| Rejected (provenance, empty, oversized) | 0 |
| Duplicates removed (8 exact + 4 formatting-only) | 12 |
| Conflicting duplicates | 0 |
| Accepted source documents | 230 (200 products, 20 policies, 10 FAQs) |

Chunk counts per embedding run are recorded in the ingestion run (`kb_ingestion_run.counts`).
