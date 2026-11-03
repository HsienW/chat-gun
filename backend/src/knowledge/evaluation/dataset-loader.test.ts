import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { contentSha256, loadEvaluationDataset, validateFreeze } from "./dataset-loader.js";
const raw = JSON.parse(await readFile("data/knowledge-eval/kb-eval-v2.json", "utf8"));
const freezeFor = (dataset: typeof raw) => ({
  datasetVersion: dataset.datasetVersion, contentSha256: contentSha256(dataset), caseCount: dataset.cases.length,
  frozenAt: "2026-11-02T00:00:00Z", review: { reviewedBy: "Master", reviewedAt: "2026-11-02T00:00:00Z", note: "test fixture only" },
});
describe("dataset freeze and CLI preflight", () => {
  it("normalizes keys and whitespace including CRLF", () => {
    expect(contentSha256({ a: 1, b: { x: 2, y: 3 } })).toBe(contentSha256({ b: { y: 3, x: 2 }, a: 1 }));
    expect(contentSha256(JSON.parse(JSON.stringify(raw, null, 2).replaceAll("\n", "\r\n")))).toBe(contentSha256(raw));
    expect(() => validateFreeze(raw, freezeFor(raw))).not.toThrow();
  });
  it("rejects a changed question or missing review", () => {
    const changed = structuredClone(raw);
    changed.cases[0].input.question += "?";
    expect(() => validateFreeze(changed, freezeFor(raw))).toThrow("EVAL_DATASET_HASH_MISMATCH");
    expect(() => validateFreeze(raw, undefined)).toThrow("EVAL_DATASET_NOT_FROZEN");
    expect(() => validateFreeze(raw, { ...freezeFor(raw), review: undefined })).toThrow("EVAL_DATASET_NOT_FROZEN");
  });
  it.each(["../kb-eval-v2", "C:/secret", "kb-eval-v2/../../x", "", "kb-eval-v2.json"])("rejects unsafe dataset %s before model creation", async (name) => {
    const createModel = vi.fn();
    await expect(loadEvaluationDataset("data/knowledge-eval", name).then(createModel)).rejects.toThrow("EVAL_DATASET_NAME_INVALID");
    expect(createModel).not.toHaveBeenCalled();
  });
  it("defaults to v1 and blocks missing or unfrozen datasets before model creation", async () => {
    const v1 = await loadEvaluationDataset("data/knowledge-eval");
    expect(v1.dataset.datasetVersion).toBe("kb-eval-v1");
    expect(v1.datasetSha256).toBe("420c787fb612a60a6edd72a838c34dbfe2a4a3d4f1b328b989e326e563b3f88d");
    const missing = vi.fn();
    await expect(loadEvaluationDataset("data/knowledge-eval", "kb-eval-v9999").then(missing)).rejects.toThrow("EVAL_DATASET_NOT_FOUND");
    expect(missing).not.toHaveBeenCalled();
    const directory = await mkdtemp(join(tmpdir(), "kb-eval-unfrozen-"));
    try {
      await writeFile(join(directory, "kb-eval-v2.json"), JSON.stringify(raw));
      const unfrozen = vi.fn();
      await expect(loadEvaluationDataset(directory, "kb-eval-v2").then(unfrozen)).rejects.toThrow("EVAL_DATASET_NOT_FROZEN");
      expect(unfrozen).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true }); }
  });
  it("pins the frozen v2 content and its Master-reviewed freeze record", async () => {
    const freeze = JSON.parse(await readFile("data/knowledge-eval/kb-eval-v2.freeze.json", "utf8"));
    expect(contentSha256(raw)).toBe("d5bbc21529c931dd6536dc0cbc842448b564bc31e3f3873e56e141c71f05af6d");
    expect(freeze).toMatchObject({ datasetVersion: "kb-eval-v2", contentSha256: contentSha256(raw), caseCount: 90, review: { reviewedBy: "Master" } });
    const v2 = await loadEvaluationDataset("data/knowledge-eval", "kb-eval-v2");
    expect(v2.datasetSha256).toBe(freeze.contentSha256);
    expect(v2.dataset.cases).toHaveLength(90);
  });
  it("allows a frozen fixture and rejects tampering before a model factory is reached", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kb-eval-freeze-"));
    try {
      await writeFile(join(directory, "kb-eval-v2.json"), JSON.stringify(raw));
      await writeFile(join(directory, "kb-eval-v2.freeze.json"), JSON.stringify(freezeFor(raw)));
      const createModel = vi.fn();
      await loadEvaluationDataset(directory, "kb-eval-v2").then(createModel);
      expect(createModel).toHaveBeenCalledOnce();
      createModel.mockClear();
      const changed = structuredClone(raw);
      changed.cases[0].input.question += " changed";
      await writeFile(join(directory, "kb-eval-v2.json"), JSON.stringify(changed));
      await expect(loadEvaluationDataset(directory, "kb-eval-v2").then(createModel)).rejects.toThrow("EVAL_DATASET_HASH_MISMATCH");
      expect(createModel).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true }); }
  });
});
