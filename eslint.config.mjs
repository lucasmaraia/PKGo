import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {ignores: ['out/', 'dist/', 'node_modules/', 'payloads/', 'test-results/', 'playwright-report/']},
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/core/**', 'src/main/**', 'src/preload/**', 'tests/**', 'e2e/**', 'scripts/**', '*.config.*'],
    languageOptions: {globals: globals.node},
  },
  {files: ['src/renderer/**'], languageOptions: {globals: globals.browser}},
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrors: 'none'}],
    },
  },
);
