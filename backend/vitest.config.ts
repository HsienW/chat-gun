import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Default (hermetic) test run. Every worker starts with these values before any test file or
// module loads, and they override the same names from the developer shell:
// - dotenv reads the committed fixture instead of backend/.env;
// - no proxy dispatcher is configured;
// - Opik export is off.
// Tests that need other values stub them explicitly. Live tests run with vitest.live.config.ts.
const hermeticDotenvPath = fileURLToPath(
  new URL("./test-support/hermetic-dotenv.txt", import.meta.url)
);

export default defineConfig({
  test: {
    env: {
      DOTENV_CONFIG_PATH: hermeticDotenvPath,
      HTTPS_PROXY: "",
      https_proxy: "",
      HTTP_PROXY: "",
      http_proxy: "",
      NODE_USE_ENV_PROXY: "",
      OPIK_ENABLED: "false",
    },
  },
});
