import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { expect, it } from "vitest";
import { runQwenFlashProbe } from "./qwen-flash-probe.js";

it.skipIf(process.env.RUN_QWEN_FLASH_PROBE !== "true")("manually probes the configured Qwen endpoint", async () => {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const evidence = await runQwenFlashProbe({
      isEnabled: true,
      endpoint: process.env.QWEN_BASE_URL ?? "",
      apiKey: process.env.QWEN_API_KEY ?? "",
      model: process.env.QWEN_CHAT_MODEL ?? "",
      signal: controller.signal,
    });
    const evidencePath = resolve("eval-results", "qwen-flash-probe.json");
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    expect(evidence.results.every((entry) => entry.status === "passed")).toBe(true);
  } finally { process.removeListener("SIGINT", cancel); }
}, 120_000);
