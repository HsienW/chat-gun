import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
// @ts-expect-error Repository test utility is intentionally native ESM.
import { checkUsageLayerBoundary } from "../../../../tools/usage-layer-boundary.mjs";

const entries = ["runtime.ts", "ledger.ts", "price-table.ts", "redis-store.ts", "attribution.ts", "token-usage.ts", "budget-configuration.ts"]
  .map(file => fileURLToPath(new URL(file, import.meta.url)));
it("rejects an injected Demo import and setting, then accepts the unmodified general import graph", () => {
  const original = fs.readFileSync(entries[0], "utf8");
  expect(() => checkUsageLayerBoundary(ts, entries, (file: string) => file === entries[0] ? `${original}\nimport '../../demo/profile.js';` : fs.readFileSync(file, "utf8"))).toThrow("forbidden_demo_import");
  console.info("boundary negative import: rejected");
  expect(() => checkUsageLayerBoundary(ts, entries, (file: string) => file === entries[0] ? `${original}\nprocess.env['DEMO_ENABLED'];` : fs.readFileSync(file, "utf8"))).toThrow("forbidden_demo_setting");
  expect(checkUsageLayerBoundary(ts, entries).length).toBeGreaterThanOrEqual(entries.length);
  console.info("boundary original graph: passed");
});
