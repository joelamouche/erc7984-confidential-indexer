// Flat ESLint config. Best-practice TypeScript rules with `any` disallowed.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Vendored / generated / non-source — not ours to lint.
    ignores: [
      "node_modules/**",
      ".ponder/**",
      "generated/**",
      "dist/**",
      "contracts/**",
      "ponder-env.d.ts",
      "eslint.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      // The point of this config: no `any`, explicit or implicit-via-cast.
      "@typescript-eslint/no-explicit-any": "error",
      // Allow intentionally-unused args/vars when prefixed with `_`.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
