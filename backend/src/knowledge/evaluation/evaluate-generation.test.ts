import { AIMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_GENERATION_MODEL } from "../../platform/generation-model-profile.js";
import { testKnowledgeConfig } from "../testing-fakes.js";
const originalArgv = process.argv;

const dependencies = vi.hoisted(() => ({
  loadDataset: vi.fn(), createModel: vi.fn(), runEvaluation: vi.fn(),
  writeFile: vi.fn(), mkdir: vi.fn(), closePool: vi.fn(),
  endpoint: vi.fn(() => ({ provider: "qwen", endpointHost: "example.test" })), supportsThinking: vi.fn(() => true),
  pool: vi.fn(), broker: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ mkdir: dependencies.mkdir, writeFile: dependencies.writeFile, readFile: vi.fn(async () => { throw new Error("absent inspection"); }) }));
vi.mock("../../platform/llm-gateway.js", () => ({
  llmGateway: { createChatModel: dependencies.createModel },
  getEffectiveLlmEndpoint: dependencies.endpoint,
  supportsConfiguredThinkingControl: dependencies.supportsThinking,
  resolveModelForPurpose: (_purpose: string, model: string) => model,
}));
vi.mock("../connection.js", () => ({
  createKnowledgePool: dependencies.pool, createKnowledgeSecretBroker: dependencies.broker,
  createSystemExecutionContext: () => ({}), KNOWLEDGE_MODEL_SECRET: {},
}));
vi.mock("../model-gateway.js", () => ({ HttpKnowledgeModelGateway: class { capabilities = { supportsRerank: false }; } }));
vi.mock("../store.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../store.js")>(), PgKnowledgeStore: class {} }));
vi.mock("./dataset-loader.js", () => ({ loadEvaluationDataset: dependencies.loadDataset }));
vi.mock("./runner.js", async (importOriginal) => ({ ...await importOriginal<typeof import("./runner.js")>(), runEvaluation: dependencies.runEvaluation }));

describe("kb-eval generation model and provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    for (const key of ["KB_EVAL_GENERATION_MODEL", "QWEN_CHAT_MODEL", "KB_EVAL_JUDGE_MODEL"]) vi.stubEnv(key, "");
    vi.stubEnv("QWEN_BASE_URL", "https://operator:fake-password@example.test/v1?key=fake-query");
    process.argv = ["node", "test-runner", "--strategies", "vector_only", "--out", "test-output"];
    dependencies.endpoint.mockReturnValue({ provider: "qwen", endpointHost: "example.test" });
    dependencies.supportsThinking.mockReturnValue(true);
    dependencies.loadDataset.mockResolvedValue({ dataset: { datasetVersion: "fake-v1", corpusVersion: "fake-corpus", rejected: [], cases: [] }, datasetSha256: "fake-sha", queryMode: "raw_question" });
    dependencies.broker.mockReturnValue({ resolve: async () => ({ value: "fake-credential" }) });
    dependencies.pool.mockResolvedValue({ end: dependencies.closePool });
    dependencies.createModel.mockImplementation(({ model }) => {
      const isJudgeFixture = ["qwen-max", "pinned-judge"].includes(model);
      return { invoke: async () => new AIMessage({ content: isJudgeFixture ? '{"supportedClaims":1,"totalClaims":1,"unsupportedClaims":[]}' : '{"abstained":false,"answer":"fake answer","citations":["c1"]}', response_metadata: { model: "gateway-filled", provider_model: isJudgeFixture ? "fake-judge-model" : "fake-generation-model", thinking_enabled: false } }) };
    });
    dependencies.runEvaluation.mockImplementation(async ({ strategy, synthesizer, judge }) => {
      const evidence = { outcome: "evidence_found", citations: [{ sourceId: "fake", title: "fake" }], chunks: [{ citationId: "c1", sourceId: "fake", title: "fake", content: "fake evidence" }] };
      await synthesizer.synthesize("fake question", evidence);
      if (judge) await judge.judge("fake question", "fake answer", evidence);
      return { strategy, status: "completed", failedCases: [], results: [], summary: { test: {}, dev: {} } };
    });
  });
  afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  async function execute() {
    const { runKnowledgeEvaluationCli } = await import("./evaluate.cli.js");
    await runKnowledgeEvaluationCli();
    const write = dependencies.writeFile.mock.calls.find(([path]) => String(path).endsWith("provenance.json"));
    expect(write).toBeDefined();
    return JSON.parse(String(write![1]));
  }

  it("uses the shared default and observes generation without including judge responses", async () => {
    const provenance = await execute();
    expect(DEFAULT_GENERATION_MODEL).toBe("qwen3.5-flash");
    expect(provenance).toMatchObject({ generationModel: DEFAULT_GENERATION_MODEL, generationModels: { chat: DEFAULT_GENERATION_MODEL }, observedProviderModels: ["fake-generation-model"], observedProviderModelsStatus: "reported", thinkingEnabled: false, llmProvider: "qwen", llmEndpointHost: "example.test", judgeModel: "qwen-max", judgePromptVersion: "kb-faithfulness-v1", embeddingModel: testKnowledgeConfig().embeddingModel });
    expect(dependencies.createModel).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_GENERATION_MODEL, thinkingEnabled: false }));
    const judgeOptions = dependencies.createModel.mock.calls.find(([options]) => options.model === "qwen-max")![0];
    expect(judgeOptions).not.toHaveProperty("thinkingEnabled");
    for (const [, content] of dependencies.writeFile.mock.calls) expect(String(content)).not.toMatch(/fake-password|fake-query|fake-credential|fake-judge-model/u);
    const report = dependencies.writeFile.mock.calls.find(([path]) => String(path).endsWith("comparison-test.md"))![1];
    expect(report).toContain("thinking=false；endpoint=example.test");
    expect(dependencies.closePool).toHaveBeenCalledOnce();
  });
  it("retains --no-judge semantics and explicit generation model precedence", async () => {
    process.argv.push("--no-judge");
    vi.stubEnv("KB_EVAL_GENERATION_MODEL", "pinned-generator");
    vi.stubEnv("QWEN_CHAT_MODEL", "purpose-generator");
    const provenance = await execute();
    expect(provenance).toMatchObject({ generationModel: "pinned-generator", generationModels: { chat: "pinned-generator" }, judgeModel: null, judgePromptVersion: null });
    expect(dependencies.createModel).toHaveBeenCalledTimes(1);
  });
  it("keeps the purpose setting ahead of the program default and preserves an explicit judge", async () => {
    vi.stubEnv("QWEN_CHAT_MODEL", "purpose-generator");
    vi.stubEnv("KB_EVAL_JUDGE_MODEL", "pinned-judge");
    expect(await execute()).toMatchObject({ generationModel: "purpose-generator", judgeModel: "pinned-judge" });
  });
  it("does not request thinking from providers without control support", async () => {
    dependencies.endpoint.mockReturnValue({ provider: "ccr", endpointHost: "ccr.test" }); dependencies.supportsThinking.mockReturnValue(false);
    process.argv.push("--no-judge");
    dependencies.createModel.mockReturnValue({ invoke: async () => new AIMessage('{"abstained":false,"answer":"fake","citations":[]}') });
    expect(await execute()).toMatchObject({ thinkingEnabled: null, llmProvider: "ccr", llmEndpointHost: "ccr.test", observedProviderModels: [], observedProviderModelsStatus: "unreported" });
    expect(dependencies.createModel.mock.calls[0]![0]).not.toHaveProperty("thinkingEnabled");
  });
  it("fails on an invalid endpoint before constructing any model or writing results", async () => {
    dependencies.endpoint.mockImplementationOnce(() => { throw new Error("invalid_configuration:LLM_BASE_URL"); });
    const { runKnowledgeEvaluationCli } = await import("./evaluate.cli.js");
    await expect(runKnowledgeEvaluationCli()).rejects.toThrow("invalid_configuration:LLM_BASE_URL");
    expect(dependencies.createModel).not.toHaveBeenCalled(); expect(dependencies.writeFile).not.toHaveBeenCalled(); expect(dependencies.pool).not.toHaveBeenCalled();
  });
  it("rejects invalid dataset input before constructing any model or writing results", async () => {
    dependencies.loadDataset.mockRejectedValueOnce(new Error("EVAL_DATASET_HASH_MISMATCH"));
    const { runKnowledgeEvaluationCli } = await import("./evaluate.cli.js");
    await expect(runKnowledgeEvaluationCli()).rejects.toThrow("EVAL_DATASET_HASH_MISMATCH");
    expect(dependencies.createModel).not.toHaveBeenCalled(); expect(dependencies.writeFile).not.toHaveBeenCalled(); expect(dependencies.pool).not.toHaveBeenCalled();
  });
});
