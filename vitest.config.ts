import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only our tests — not the vendored Solidity deps under contracts/lib.
    include: ["test/**/*.test.ts"],
  },
});
