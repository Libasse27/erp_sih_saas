// @ts-check
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/**
 * Regle D3 (docs/architecture/01-target-architecture.md §8) : strict:true, aucun `any`,
 * aucun `@ts-ignore`. Les violations d'architecture (domain/ sans framework) sont verifiees
 * separement par dependency-cruiser (apps/api/.dependency-cruiser.cjs), pas par ESLint.
 */
export default [
  {
    ignores: ['**/dist/**', '**/build/**', '**/coverage/**', '**/node_modules/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-expect-error': false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
];
