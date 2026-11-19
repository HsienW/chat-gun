import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { asyncExitHook } from "exit-hook";
import { startServer, StartServerSchema } from "@langchain/langgraph-api/server";

// Use the package's public server API. Graphs, storage, HTTP routes and workers
// remain owned by the upstream package; no replacement checkpointer is injected.
const cwd = fileURLToPath(new URL(".", import.meta.url));
const config = JSON.parse(await readFile(new URL("./langgraph.json", import.meta.url), "utf8"));
const options = StartServerSchema.parse({
  ...config,
  cwd,
  host: process.env.RUNTIME_HOST,
  port: Number(process.env.RUNTIME_PORT),
  nWorkers: Number(process.env.RUNTIME_WORKERS),
});
if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535
    || !Number.isInteger(options.nWorkers) || options.nWorkers < 1) {
  throw new Error("invalid_configuration:runtime_listener_or_workers");
}
process.env.PORT = String(options.port);
process.env.LANGGRAPH_API_URL = `http://${options.host}:${options.port}`;
const { cleanup } = await startServer(options);
// Match the package's own CLI entrypoint; cleanup is supplied by startServer.
asyncExitHook(cleanup, { wait: 3000 });
