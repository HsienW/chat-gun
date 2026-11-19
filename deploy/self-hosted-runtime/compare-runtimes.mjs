import { spawnSync } from "node:child_process";
import { compose, docker, must, containerRequest, record, digest, guard } from "./validation.mjs";

const results = [];
try {
  for (const mode of ["custom", "legacy"]) {
    const command = [...compose, "--file", "deploy/self-hosted-runtime/negative.yaml"];
    if (mode === "legacy") command.push("--file", "deploy/self-hosted-runtime/legacy.yaml");
    const startup = must(docker([...command, "up", "--detach", "--force-recreate", "--wait", "--wait-timeout", "90", "runtime", "bff"]));
    guard();
    const raw = spawnSync("docker", ["inspect", "--format", "{{json .Config.Env}}", "chat-gun-runtime-spike-runtime-1"], { encoding: "utf8", windowsHide: true });
    if (raw.status !== 0) throw Error("environment_inspection_failed");
    const environment = JSON.parse(raw.stdout).sort();
    if (environment.some(entry => entry.startsWith("QWEN_API_KEY=") && entry !== "QWEN_API_KEY=")) throw Error("key_not_empty");
    const ready = containerRequest("chat-gun-runtime-spike-bff-1", "/api/ready");
    const metadata = containerRequest("chat-gun-runtime-spike-runtime-1", "/internal/usage-ledger/metadata");
    const logs = docker(["logs", "--tail", "80", "chat-gun-runtime-spike-runtime-1"]);
    results.push({ mode, startup, environmentSha256: digest(environment), environmentNames: environment.map(value => value.split("=", 1)[0]), modelKeyPresent: false, ready, metadata, logs });
    record("comparison", { results, status: "in_progress" });
  }
  const sameEnvironment = results[0].environmentSha256 === results[1].environmentSha256;
  const sameReady = results[0].ready.status === results[1].ready.status && digest(results[0].ready.body) === digest(results[1].ready.body);
  const sameMetadata = digest(results[0].metadata) === digest(results[1].metadata);
  const passed = sameEnvironment && sameReady && sameMetadata;
  record("comparison", { results, sameEnvironment, sameReady, sameMetadata, status: passed ? "pass" : "fail",
    existingProductGap: passed && JSON.parse(results[0].ready.body).status === "ready" ? "缺少模型金鑰仍回 ready，兩種 runtime 一致；屬既有產品設定檢查缺口。" : null });
  console.log(JSON.stringify({ status: passed ? "pass" : "fail", sameEnvironment, sameReady, sameMetadata, outputs: results.map(r => ({ mode: r.mode, ready: r.ready })) }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  record("comparison", { results, status: "error", error: error.message, failedCommand: error.result || null });
  console.log(JSON.stringify({ status: "error", error: error.message, failedCommand: error.result || null }));
  process.exitCode = 1;
}
