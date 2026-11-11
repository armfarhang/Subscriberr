import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.data/**', '.backups/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Spec §4.1 rule 3: the raw DB client may only be imported inside core/ and db/.
    // Everything else gets a handle from core/workspace-context.ts.
    files: ['server/src/**/*.ts'],
    ignores: ['server/src/core/**', 'server/src/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/db/client', '**/db/client.js', 'better-sqlite3'],
              allowTypeImports: true,
              message: 'Obtain a DB handle from core/workspace-context.ts (Spec §4.1 rule 3).',
            },
          ],
        },
      ],
    },
  },
  {
    // shared/ must not import from server/ or web/ (Spec §4.1 rule 4).
    files: ['shared/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/server/**', '**/web/**', '@subscriberr/server', '@subscriberr/web'] }],
    },
  },
);
