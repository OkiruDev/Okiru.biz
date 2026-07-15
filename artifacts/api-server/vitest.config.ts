import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // LibreOffice (soffice) conversions cold-start slowly (~8s+), so the 5s
    // default would flake the real-fixture rendering tests.
    testTimeout: 60_000,
    // Run in production mode so the logger uses plain stdout instead of the
    // pino-pretty worker thread, which can otherwise keep the test runner alive.
    env: {
      NODE_ENV: "production",
    },
  },
  resolve: {
    conditions: ["workspace"],
  },
});
