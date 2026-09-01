import osirisConfig from '@osiris/eslint-config';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/lib/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.build/**',
      '**/media/*.js',
      '**/test/fixtures/**',
    ],
  },
  ...osirisConfig,
];
