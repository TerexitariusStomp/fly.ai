/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/.next/",
      "*.bak",
      "**/.wrangler/",
      "*.md",
      "*.d.ts",
      "bun.lock",
      "bun.lockb",
      "worker-configuration.d.ts",
      ".opencode/",
      "examples/",
      ".tmp/",
      "**/dist.bak/",
      ".agents/",
      ".worktrees/",
      "packages/shared/scripts/",
      "papers/scripts/",
    ],
  },
  js.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    files: [
      "**/*.js",
      "**/*.jsx",
      "**/*.mjs",
      "**/*.cjs",
      "**/*.ts",
      "**/*.tsx",
      "**/*.mts",
      "**/*.cts",
    ],
    languageOptions: {
      globals: {
        ...globals.es2021,
        ...globals.node,
        ...globals.jest,
        Bun: "readonly",
        // k6 load testing globals
        __ENV: "readonly",
        __ITER: "readonly",
        __VU: "readonly",
      },
    },
    rules: {
      "prettier/prettier": "warn",
      "no-console": "off",
      "no-empty": "warn",
      "no-control-regex": "warn",
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        projectService: true,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript handles this more accurately; disable to avoid false
      // positives from Cloudflare Workers types (Fetcher, KVNamespace, etc.)
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-var-requires": "off",
      // Production TS: ban `any` and bare `as any` (tests relax below).
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          minimumDescriptionLength: 8,
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSAnyKeyword",
          message:
            "Avoid `as any`. Use runtime narrowing, generics, or `unknown` + guards.",
        },
      ],
      // Cloudflare Workers best practice: floating promises drop work / errors.
      // https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      parserOptions: {
        project: null,
      },
    },
  },
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "workers/*/test/**",
      "packages/*/test/**",
      "packages/*/tests/**",
      "tests/live/**",
    ],
    languageOptions: {
      parserOptions: {
        project: null,
        projectService: false,
      },
    },
    rules: {
      // Test files intentionally use `any` for mocks/fixtures and may have
      // unused parameters across AAA phases. AGENTS.md: "ESLint relaxes
      // rules in test files". The `argsIgnorePattern: "^_"` from the main
      // rule config still applies if these rules are re-enabled later.
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-ts-comment": "warn",
      "no-empty": "warn",
      // Allow `as any` in tests (mocks); production still bans via main block.
      "no-restricted-syntax": "off",
      // Typed rule; test block disables projectService so it cannot run here.
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
];
