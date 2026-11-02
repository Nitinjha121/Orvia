// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * Lint configuration focused on common error patterns without formatting noise.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'packages/theme/theme.css',
      'apps/web/dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      /**
       * `_`-prefixed arguments are deliberate throwaways — `createParamDecorator`
       * hands every decorator a `_data` it does not want.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      /**
       * The SDK's `parts` and `functionResponses` are typed far more narrowly
       * than the wire format accepts, so `as never` is the documented way past
       * them. Downgraded rather than disabled: a NEW one should still be
       * visible in the output, just not fail the build.
       */
      '@typescript-eslint/no-explicit-any': 'warn',

      /**
       * Empty catch blocks are how "already gone — reopening is the point" is
       * written here, and every one of them carries a comment saying so. The
       * rule still fires on an empty block anywhere else.
       */
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  /* ── the API: Node, and decorators everywhere ──────────────────────────── */
  {
    files: ['apps/api/**/*.ts', 'packages/**/*.ts', 'tools/**/*.{ts,mts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  /**
   * ── the audio thread ──────────────────────────────────────────────────────
   * A worklet runs in `AudioWorkletGlobalScope`, which is neither Node nor the
   * window: no `document`, no `fetch`, but `AudioWorkletProcessor` and
   * `registerProcessor` are ambient.
   */
  {
    files: ['apps/web/public/worklets/**/*.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
        currentTime: 'readonly',
        currentFrame: 'readonly',
      },
    },
  },

  /* ── the browser ───────────────────────────────────────────────────────── */
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      /** Enforces React Hooks rules to prevent stale closures in effect and callback hooks. */
      ...reactHooks.configs.recommended.rules,
    },
  },
);
