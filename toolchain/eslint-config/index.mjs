import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Shared flat ESLint config for every Osiris workspace.
 * Consumers do: `import osiris from '@osiris/eslint-config'; export default [...osiris];`
 *
 * @type {import('eslint').Linter.Config[]}
 */
export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.test.mjs',
      '**/test/**',
      '**/*.config.*',
      '**/esbuild.mjs',
      // CLI-style scripts, the web server wrapper and the desktop runtime hook
      // legitimately write to stdout.
      'apps/*/scripts/**',
      'apps/*/server/**',
      'apps/*/runtime/**',
      'packages/*/scripts/**',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['**/webview/**', '**/media/**', 'apps/osiris-console/src/**', 'apps/osiris-console/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  prettier,
];
