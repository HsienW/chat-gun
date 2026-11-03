import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { evalDatasetSchema, parseEvalDataset } from "./eval-case.js";

function canonicalize(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonicalize);
  if (input !== null && typeof input === "object") return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonicalize(value)]));
  return input;
}
/** Hash parsed JSON, independent of key order and file line endings. */
export function contentSha256(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex");
}
const freezeSchema = z.object({
  datasetVersion: z.string(), contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  caseCount: z.number().int().positive(), frozenAt: z.string().datetime(),
  review: z.object({ reviewedBy: z.literal("Master"), reviewedAt: z.string().datetime(), note: z.string().min(1) }).strict(),
}).strict();
export function validateFreeze(input: unknown, freeze: unknown): void {
  const dataset = evalDatasetSchema.parse(input);
  const parsed = freezeSchema.safeParse(freeze);
  if (!parsed.success) throw new Error("EVAL_DATASET_NOT_FROZEN");
  if (parsed.data.contentSha256 !== contentSha256(input) || parsed.data.datasetVersion !== dataset.datasetVersion || parsed.data.caseCount !== dataset.cases.length) throw new Error("EVAL_DATASET_HASH_MISMATCH");
}
async function readDatasetJson(file: string, missingCode: string): Promise<unknown> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error(missingCode);
    throw error;
  }
  return JSON.parse(text);
}
/** CLI must await this before constructing any gateway, model, broker or database pool. */
export async function loadEvaluationDataset(directory: string, name = "kb-eval-v1") {
  if (!/^kb-eval-v[0-9]+$/u.test(name)) throw new Error("EVAL_DATASET_NAME_INVALID");
  const raw = await readDatasetJson(join(directory, `${name}.json`), "EVAL_DATASET_NOT_FOUND");
  const envelope = evalDatasetSchema.parse(raw);
  if (envelope.datasetVersion !== name) throw new Error("EVAL_DATASET_VERSION_MISMATCH");
  const dataset = parseEvalDataset(raw);
  if (dataset.rejected.length) throw new Error(`EVAL_DATASET_INVALID: ${JSON.stringify(dataset.rejected)}`);
  if (name === "kb-eval-v2" || envelope.freezeRequired === true) {
    const freeze = await readDatasetJson(join(directory, `${name}.freeze.json`), "EVAL_DATASET_NOT_FROZEN");
    validateFreeze(raw, freeze);
  }
  return { dataset, datasetSha256: contentSha256(raw), queryMode: "raw_question" as const };
}
