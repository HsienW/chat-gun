import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

const E2E_FIXED_DELAY_MESSAGE =
  'E2E waits on scenario gates or UI state, never on fixed time (design D6).'

export default tseslint.config(
  { ignores: ['dist', 'dist-e2e', 'playwright-report', 'test-results'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // Not React code: Playwright fixtures name their callback `use`.
      'react-hooks/rules-of-hooks': 'off',
      'react-refresh/only-export-components': 'off',
      'no-restricted-properties': [
        'error',
        { property: 'waitForTimeout', message: E2E_FIXED_DELAY_MESSAGE },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: E2E_FIXED_DELAY_MESSAGE },
        { name: 'setInterval', message: E2E_FIXED_DELAY_MESSAGE },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'timers/promises', message: E2E_FIXED_DELAY_MESSAGE },
            { name: 'node:timers/promises', message: E2E_FIXED_DELAY_MESSAGE },
            { name: 'timers', message: E2E_FIXED_DELAY_MESSAGE },
            { name: 'node:timers', message: E2E_FIXED_DELAY_MESSAGE },
          ],
        },
      ],
    },
  },
)
