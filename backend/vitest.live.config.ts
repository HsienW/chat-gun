import { defineConfig } from "vitest/config";

// Live test run, for opt-in tests that need real runtime settings, the proxy or hosted services.
// It keeps the runtime behavior: backend/.env is loaded and proxy settings apply.
// Each live test still requires its own opt-in flag and skips without it.
//
//   npm run eval:opik
//   npx vitest run --config vitest.live.config.ts <live test file>
export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts", "src/**/*.live-smoke.test.ts"],
  },
});
