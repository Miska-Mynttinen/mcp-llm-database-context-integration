// ESLint flat config for the whole monorepo: root API server, workspace
// packages, React frontend and the node:test suites.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

const MAX_NESTING_DEPTH = 4;
const MAX_FILE_LINES = 800;
const MAX_FUNCTION_LINES = 50;

const TS_FILES = ['**/*.{ts,tsx}'];

// Shared code-quality rules (see ~/.claude/rules/common/coding-style.md).
const codeQualityRules = {
  'prefer-const': 'error',
  'no-var': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-param-reassign': ['error', { props: false }],
  'no-empty': ['error', { allowEmptyCatch: false }],
  'no-throw-literal': 'error',
  'object-shorthand': 'error',
  'prefer-template': 'error',
  'max-depth': ['error', MAX_NESTING_DEPTH],
  'max-lines': ['error', { max: MAX_FILE_LINES, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['warn', { max: MAX_FUNCTION_LINES, skipBlankLines: true, skipComments: true }],
  'no-console': ['warn', { allow: ['warn', 'error'] }],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'coverage/**',
    ],
  },

  js.configs.recommended,
  {
    rules: codeQualityRules,
  },

  // TypeScript (all packages): recommended + type-aware promise checks.
  {
    files: TS_FILES,
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      'no-throw-literal': 'off',
    },
  },

  // Node backend: root server and workspace packages.
  {
    files: ['index.ts', 'src/**/*.ts', 'packages/*/src/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // CLI scripts print their results for the operator.
  {
    files: ['src/auth/seedUsers.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // React frontend.
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['frontend/vite.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // node:test suites are plain CommonJS.
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'max-lines-per-function': 'off',
      'no-console': 'off',
    },
  },
);
