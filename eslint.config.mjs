// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Ignore build output and generated files
  {
    ignores: ['cdk.out/**', 'node_modules/**', 'dist/**', '*.js'],
  },

  // Core ESLint recommended rules
  js.configs.recommended,

  // TypeScript-specific recommended rules
  ...tseslint.configs.recommended,

  // Your own rule overrides / project preferences
  {
    rules: {
      // Warn (not error) on unused vars, but allow _-prefixed args to be ignored
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_' },
      ],

      // CDK/Lambda code often has legitimate `any` (e.g. event payloads) — warn, don't block CI
      '@typescript-eslint/no-explicit-any': 'warn',

      // Encourage but don't force explicit return types (CDK constructs get verbose otherwise)
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
);