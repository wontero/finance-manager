import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@finance-manager/core": fileURLToPath(
        new URL("./src/core/index.ts", import.meta.url),
      ),
      "@": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  test: {
    include:
      mode === "integration"
        ? ["src/**/*.integration.test.ts"]
        : ["src/**/*.test.{ts,tsx}"],
    exclude: mode === "integration" ? [] : ["src/**/*.integration.test.ts"],
  },
}));
