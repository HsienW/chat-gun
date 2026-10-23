/**
 * Generates the synthetic X42 knowledge corpus deterministically.
 *
 * Usage: npx tsx scripts/knowledge/generate-synthetic-corpus.ts
 *
 * The raw output intentionally contains duplicate and noisy product records so the
 * ingestion pipeline's normalize and dedupe stages have measurable work to do.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { POLICY_DOCUMENTS } from "./policy-documents.js";

export const CORPUS_VERSION = "kb-v1";
export const GENERATED_AT = "2026-10-23";
const SEED = 42;
const PRODUCTS_PER_CATEGORY = 25;
const EXACT_DUPLICATES = 8;
const NOISY_DUPLICATES = 4;

const OUTPUT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  "knowledge-corpus",
  CORPUS_VERSION,
  "raw"
);

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(SEED);
const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
const pickSome = <T>(values: readonly T[], count: number): T[] => {
  const pool = [...values];
  const picked: T[] = [];
  while (picked.length < count && pool.length > 0) {
    picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  }
  return picked;
};
const priceBetween = (min: number, max: number): number =>
  Math.round((min + random() * (max - min) - 0.01) * 100) / 100;

interface CategorySeed {
  category: string;
  skuPrefix: string;
  nouns: readonly string[];
  brands: readonly string[];
  priceRange: readonly [number, number];
  colors: readonly string[];
  features: readonly string[];
  specs: () => Record<string, string>;
  warrantyMonths: readonly number[];
}

const CATEGORIES: readonly CategorySeed[] = [
  {
    category: "headphones",
    skuPrefix: "HP",
    nouns: ["Wireless Headphones", "Noise-Cancelling Headphones", "Earbuds", "Studio Headphones", "Sport Earbuds"],
    brands: ["Auralis", "Northwave", "Tonic", "Kestrel Audio"],
    priceRange: [39, 349],
    colors: ["black", "white", "navy", "sand", "forest green"],
    features: ["active noise cancellation", "transparency mode", "multipoint Bluetooth", "wireless charging case", "foldable design", "USB-C fast charging", "spatial audio"],
    specs: () => ({
      batteryHours: String(pick([20, 24, 30, 40, 50])),
      bluetooth: pick(["5.2", "5.3", "5.4"]),
      weightGrams: String(pick([45, 180, 220, 250, 290])),
    }),
    warrantyMonths: [12, 24],
  },
  {
    category: "smartwatches",
    skuPrefix: "SW",
    nouns: ["Smartwatch", "Fitness Watch", "GPS Running Watch", "Hybrid Watch"],
    brands: ["Pulseframe", "Orbit", "Tempo", "Kestrel"],
    priceRange: [79, 499],
    colors: ["graphite", "silver", "rose gold", "midnight", "olive"],
    features: ["heart-rate monitoring", "built-in GPS", "sleep tracking", "contactless payments", "always-on display", "blood-oxygen sensor"],
    specs: () => ({
      waterResistance: pick(["IP67", "IP68", "5 ATM", "10 ATM"]),
      batteryDays: String(pick([2, 5, 7, 14, 21])),
      displayInches: pick(["1.2", "1.4", "1.6", "1.9"]),
    }),
    warrantyMonths: [12, 24],
  },
  {
    category: "backpacks",
    skuPrefix: "BP",
    nouns: ["Commuter Backpack", "Travel Backpack", "Hiking Daypack", "Laptop Backpack"],
    brands: ["Trailmark", "Cobble & Co", "Ridgeline"],
    priceRange: [35, 229],
    colors: ["charcoal", "olive", "rust", "black", "slate blue"],
    features: ["padded 16-inch laptop sleeve", "water-resistant fabric", "luggage pass-through", "hidden anti-theft pocket", "hip belt", "lifetime zipper repair"],
    specs: () => ({
      capacityLiters: String(pick([18, 22, 26, 30, 35, 40])),
      weightGrams: String(pick([680, 820, 950, 1100, 1300])),
    }),
    warrantyMonths: [24, 60],
  },
  {
    category: "running-shoes",
    skuPrefix: "RS",
    nouns: ["Road Running Shoe", "Trail Running Shoe", "Racing Flat", "Stability Running Shoe"],
    brands: ["Stride Lab", "Velo", "Northwave Run"],
    priceRange: [59, 219],
    colors: ["black/white", "volt", "ocean blue", "coral", "grey"],
    features: ["carbon plate", "wide toe box", "reflective details", "recycled upper", "rock plate", "high-cushion midsole"],
    specs: () => ({
      dropMm: String(pick([0, 4, 6, 8, 10])),
      weightGrams: String(pick([210, 240, 270, 300])),
      sizes: "US 6-14",
    }),
    warrantyMonths: [6],
  },
  {
    category: "coffee-makers",
    skuPrefix: "CM",
    nouns: ["Drip Coffee Maker", "Espresso Machine", "Pour-Over Kettle", "Cold Brew Maker", "Burr Grinder"],
    brands: ["Brewhaus", "Ember & Bean", "Morning Lab"],
    priceRange: [29, 699],
    colors: ["stainless steel", "matte black", "cream", "copper"],
    features: ["programmable timer", "built-in grinder", "thermal carafe", "milk frother", "temperature control", "auto shut-off"],
    specs: () => ({
      capacityCups: String(pick([1, 4, 8, 10, 12])),
      powerWatts: String(pick([600, 900, 1200, 1500])),
    }),
    warrantyMonths: [12, 24],
  },
  {
    category: "desk-lamps",
    skuPrefix: "DL",
    nouns: ["LED Desk Lamp", "Architect Lamp", "Monitor Light Bar", "Clamp Lamp"],
    brands: ["Lumen Works", "Halo", "Ridgeline Home"],
    priceRange: [19, 189],
    colors: ["white", "black", "brass", "sage"],
    features: ["adjustable color temperature", "USB-C charging port", "touch dimmer", "auto-dim sensor", "memory function"],
    specs: () => ({
      lumens: String(pick([400, 600, 800, 1000])),
      colorTemperatureK: pick(["2700-6500", "3000-6000", "2700-5000"]),
    }),
    warrantyMonths: [12, 24],
  },
  {
    category: "phone-cases",
    skuPrefix: "PC",
    nouns: ["Clear Case", "Rugged Case", "Leather Folio", "MagSafe-Compatible Case"],
    brands: ["Shellcraft", "Tonic", "Orbit"],
    priceRange: [12, 69],
    colors: ["clear", "black", "tan", "lilac", "forest green"],
    features: ["raised camera lip", "drop protection up to 3 m", "magnetic wireless charging", "card slot", "antimicrobial coating"],
    specs: () => ({
      dropRatingMeters: String(pick([1.2, 2, 3, 4])),
      compatibleWith: pick(["6.1-inch phones", "6.7-inch phones", "6.3-inch phones"]),
    }),
    warrantyMonths: [6, 12],
  },
  {
    category: "yoga-mats",
    skuPrefix: "YM",
    nouns: ["Yoga Mat", "Travel Yoga Mat", "Cork Yoga Mat", "Thick Exercise Mat"],
    brands: ["Stillpoint", "Velo", "Groundwork"],
    priceRange: [19, 149],
    colors: ["sage", "terracotta", "charcoal", "sky blue", "natural cork"],
    features: ["non-slip surface", "alignment lines", "carry strap", "natural rubber base", "foldable"],
    specs: () => ({
      thicknessMm: String(pick([1.5, 4, 6, 8, 10])),
      lengthCm: String(pick([173, 183, 200])),
    }),
    warrantyMonths: [6, 12],
  },
];

export interface RawProductRecord {
  synthetic: true;
  corpusVersion: string;
  generatedAt: string;
  sourceId: string;
  sourceType: "product";
  sku: string;
  title: string;
  brand: string;
  category: string;
  priceUsd: number;
  colors: string[];
  features: string[];
  specs: Record<string, string>;
  warrantyMonths: number;
  finalSale: boolean;
  stockStatus: "in_stock" | "low_stock" | "backorder";
  description: string;
}

function describe(record: Omit<RawProductRecord, "description">): string {
  const sale = record.finalSale
    ? "This item is sold as final sale and cannot be returned unless it arrives damaged or defective."
    : "This item can be returned within the standard return window.";
  const specs = Object.entries(record.specs)
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
  return [
    `${record.title} by ${record.brand} (${record.sku}) in the ${record.category} category, priced at ${record.priceUsd.toFixed(2)} USD.`,
    `Available colors: ${record.colors.join(", ")}.`,
    `Key features: ${record.features.join(", ")}.`,
    `Specifications: ${specs}.`,
    `Covered by a ${record.warrantyMonths}-month manufacturer warranty.`,
    sale,
  ].join(" ");
}

function generateProducts(): RawProductRecord[] {
  const products: RawProductRecord[] = [];
  for (const seed of CATEGORIES) {
    for (let index = 0; index < PRODUCTS_PER_CATEGORY; index += 1) {
      const sku = `${seed.skuPrefix}-${String(1001 + index)}`;
      const brand = pick(seed.brands);
      const noun = pick(seed.nouns);
      const base = {
        synthetic: true as const,
        corpusVersion: CORPUS_VERSION,
        generatedAt: GENERATED_AT,
        sourceId: `product-${sku.toLowerCase()}`,
        sourceType: "product" as const,
        sku,
        title: `${brand} ${noun} ${pick(["Lite", "Pro", "Max", "Air", "One", "2", "X"])}`,
        brand,
        category: seed.category,
        priceUsd: priceBetween(seed.priceRange[0], seed.priceRange[1]),
        colors: pickSome(seed.colors, 1 + Math.floor(random() * 3)),
        features: pickSome(seed.features, 2 + Math.floor(random() * 3)),
        specs: seed.specs(),
        warrantyMonths: pick(seed.warrantyMonths),
        finalSale: random() < 0.08,
        stockStatus: pick(["in_stock", "in_stock", "in_stock", "low_stock", "backorder"] as const),
      };
      products.push({ ...base, description: describe(base) });
    }
  }
  return products;
}

/** Raw feeds often repeat records or carry formatting noise; the pipeline must clean both. */
function addRawNoise(products: readonly RawProductRecord[]): RawProductRecord[] {
  const raw = [...products];
  for (const original of pickSome(products, EXACT_DUPLICATES)) {
    raw.push({ ...original });
  }
  for (const original of pickSome(products, NOISY_DUPLICATES)) {
    raw.push({
      ...original,
      title: `  ${original.title.toUpperCase()}  `,
      description: `${original.description.replaceAll(" ", "  ").replace(" USD", "&nbsp;USD")}\n\n`,
    });
  }
  return raw;
}

function policyMarkdown(seed: (typeof POLICY_DOCUMENTS)[number]): string {
  return [
    "---",
    "synthetic: true",
    `corpusVersion: ${CORPUS_VERSION}`,
    `generatedAt: ${GENERATED_AT}`,
    `sourceId: ${seed.sourceId}`,
    `sourceType: ${seed.sourceType}`,
    `title: ${seed.title}`,
    "---",
    "",
    `# ${seed.title}`,
    "",
    seed.body,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const products = generateProducts();
  const rawProducts = addRawNoise(products);

  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await mkdir(join(OUTPUT_ROOT, "policies"), { recursive: true });
  await writeFile(join(OUTPUT_ROOT, "products.json"), `${JSON.stringify(rawProducts, null, 2)}\n`);
  for (const document of POLICY_DOCUMENTS) {
    await writeFile(join(OUTPUT_ROOT, "policies", `${document.sourceId}.md`), policyMarkdown(document));
  }
  const manifest = {
    synthetic: true,
    corpusVersion: CORPUS_VERSION,
    generatedAt: GENERATED_AT,
    generator: "backend/scripts/knowledge/generate-synthetic-corpus.ts",
    seed: SEED,
    counts: {
      uniqueProducts: products.length,
      rawProductRecords: rawProducts.length,
      exactDuplicates: EXACT_DUPLICATES,
      noisyDuplicates: NOISY_DUPLICATES,
      policyDocuments: POLICY_DOCUMENTS.filter((document) => document.sourceType === "policy").length,
      faqDocuments: POLICY_DOCUMENTS.filter((document) => document.sourceType === "faq").length,
    },
  };
  await writeFile(join(OUTPUT_ROOT, "..", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest.counts)}\n`);
}

await main();
