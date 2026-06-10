// Flat config (ESLint 9+). DC Bar engineering standard.
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // NOTE: This is a POC adopting lint over an existing codebase. The rules
      // below are intentionally `warn` (not `error`) so the gate is green today
      // while the debt stays visible. Ratchet each to `error` as the code is
      // cleaned up (tracked in findings.md). The DC Bar standard is no `any`.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Platform standard: no console.log in committed code — use the structured logger.
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "data/**"],
  },
];
