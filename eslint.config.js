// @ts-check
/**
 * ESLint 9 flat config for cortex.
 *
 * Ported from arc's config (see `the-metafactory/arc/eslint.config.js`,
 * post-PR #150 sweep that drove arc to 0 warnings), with cortex-specific
 * ignores added for the worker/webhook-proxy/dashboard-v2 surfaces that
 * already live outside `tsc --noEmit` scope per `tsconfig.json` exclude.
 *
 * Strict TypeScript baseline:
 *   - @eslint/js recommended
 *   - typescript-eslint strictTypeChecked + stylisticTypeChecked
 *
 * Type-aware rules use `projectService: true` so callsite types resolve
 * identically to `bunx tsc --noEmit`.
 *
 * Run:
 *   bun run lint           # full report (errors + warnings)
 *   bun run lint:errors    # errors-only (CI gate)
 *   bun run lint:fix       # auto-fix where possible
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Strict (error): type-safety bugs we genuinely want to gate on ──
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Real correctness rules backported from arc-eslint
      "@typescript-eslint/restrict-plus-operands": "error",
      "no-useless-escape": "error",
      "no-useless-assignment": "error",
      "no-control-regex": "error",
      "@typescript-eslint/no-require-imports": "error",
      // `throw new Error(msg)` from a catch block should pass
      // `{ cause: err }` to preserve the exception chain.
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",

      // Strict-typed baseline rules
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-empty-function": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-base-to-string": "error",
      // Number/boolean interpolation in template literals reads
      // cleanly; the rule still fires on unknown/never/any/exotic.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "@typescript-eslint/return-await": "error",
      "@typescript-eslint/no-unused-expressions": "error",
      "@typescript-eslint/unbound-method": "error",
      "@typescript-eslint/no-confusing-void-expression": "error",
    },
  },
  {
    // Test files: looser rules — tests intentionally exercise edge
    // cases (any-typed mocks, unsafe casts for failure injection).
    // Mirrors arc's test-file override block.
    files: [
      "**/*.test.ts",
      "**/__tests__/**/*.ts",
      "tests/**/*.ts",
      "src/**/__tests__/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    // Files outside the typed-project scope. cortex's tsconfig.json
    // excludes the worker / webhook-proxy / dashboard-v2 surfaces; the
    // lint config mirrors that to avoid projectService errors on files
    // tsc never type-checks.
    ignores: [
      "dist/",
      "node_modules/",
      "src/bus/myelin/vendor/",
      "src/worker/",
      "src/webhook-proxy/",
      "src/surface/mc/worker/",
      "src/services/network-registry/",
      "src/taps/gh-webhook/",
      "src/surface/mc/dashboard-v2/",
      "**/*.bak.ts",
      "eslint.config.js",
      "scripts/",
      ".github/scripts/",
      ".claude/",
      ".specify/",
      ".triage/",
      "MEMORY/",
      "Plans/",
      "../grove-auth/",
    ],
  },
);
