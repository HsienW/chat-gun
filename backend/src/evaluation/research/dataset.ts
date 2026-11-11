import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

export const RESEARCH_EVAL_CATEGORIES = ["answerable", "no_source", "clarify"] as const;
export const RESEARCH_EVAL_STUBS = ["empty_search", "fetch_fail"] as const;

export type ResearchEvalCategory = (typeof RESEARCH_EVAL_CATEGORIES)[number];
export type ResearchEvalStub = (typeof RESEARCH_EVAL_STUBS)[number];

const caseSchema = z
  .object({
    caseId: z.string().regex(/^[a-z]{3}-\d{2}$/u),
    category: z.enum(RESEARCH_EVAL_CATEGORIES),
    stub: z.enum(RESEARCH_EVAL_STUBS).optional(),
    language: z.enum(["en", "zh-TW", "zh-CN"]),
    question: z.string().min(5).max(500),
  })
  .strict()
  .refine((item) => (item.category === "no_source") === (item.stub !== undefined), {
    message: "no_source cases need a stub and other cases must not have one",
  });

const datasetSchema = z
  .object({
    datasetVersion: z.string().regex(/^research-eval-v\d+$/u),
    description: z.string().min(1),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    categories: z.record(z.enum(RESEARCH_EVAL_CATEGORIES), z.string().min(1)),
    cases: z.array(caseSchema).min(1),
  })
  .strict()
  .refine((dataset) => new Set(dataset.cases.map((item) => item.caseId)).size === dataset.cases.length, {
    message: "caseId values must be unique",
  });

export type ResearchEvalCase = z.infer<typeof caseSchema>;
export type ResearchEvalDataset = z.infer<typeof datasetSchema>;

export interface LoadedResearchDataset {
  dataset: ResearchEvalDataset;
  /** SHA-256 over the canonical JSON of the validated dataset, so whitespace edits do not change it. */
  sha256: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

export function parseResearchDataset(input: unknown): LoadedResearchDataset {
  const parsed = datasetSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `RESEARCH_EVAL_DATASET_INVALID: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`
    );
  }
  const sha256 = createHash("sha256").update(JSON.stringify(canonicalize(parsed.data))).digest("hex");
  return { dataset: parsed.data, sha256 };
}

export async function loadResearchDataset(file: string): Promise<LoadedResearchDataset> {
  return parseResearchDataset(JSON.parse(await readFile(file, "utf8")));
}
