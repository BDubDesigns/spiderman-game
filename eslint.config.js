// @ts-check
/**
 * ESLint flat config.
 *
 * Type-aware linting (`recommendedTypeChecked`) on purpose: the interesting bugs
 * in this codebase are type-shaped — a floating promise in the render loop, an
 * unsafe `unknown` narrowed by assertion instead of by a guard, an unnecessary
 * cast hiding a real type change. Rules that only need syntax cannot see those.
 *
 * The parser is pointed at the same `tsconfig.json` the build and `vitest` use,
 * so lint cannot disagree with `tsc` about what the project is.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      // Local npm cache, created only when the machine's global npm cache is not
      // writable. Never linted, never committed.
      '.npm-cache/**',
    ],
  },
  {
    // Source and tests only. `eslint.config.js` itself and the JSON fixtures are
    // not usefully lintable by these rules.
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /**
       * `verbatimModuleSyntax` in tsconfig.json already requires `import type`
       * for type-only imports. This keeps lint and the compiler telling the same
       * story, and catches a value import that is only ever used as a type.
       */
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      /**
       * Unused arguments are already a compile error via `noUnusedParameters`,
       * but that check ignores names starting with `_`. Mirror the same
       * convention here so the two agree instead of contradicting each other.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Node build/asset scripts. They are real code with real failure modes
    // (checksums, missing assets), so they get linted too — with Node globals
    // rather than browser ones, and without the type-aware rules, since they are
    // plain ESM outside the TypeScript project.
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
);
