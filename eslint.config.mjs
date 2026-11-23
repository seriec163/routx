import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'agent/dist/**',
      '**/*.d.ts',
      'web/public/**',
      '.playwright-mcp/**',
      'audit/**',
      'docs/assets/**',
      'tmp_apk_root/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      'no-debugger': 'error',
      'no-dupe-else-if': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unsafe-finally': 'error',
      'no-self-assign': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // В коде есть eslint-disable для правила react-hooks, но плагин не
    // подключён. Регистрируем пустое правило, чтобы комментарии не падали.
    plugins: {
      'react-hooks': {
        rules: {
          'exhaustive-deps': {
            meta: { schema: [] },
            create: () => ({}),
          },
        },
      },
    },
    rules: { 'react-hooks/exhaustive-deps': 'off' },
  },
);
