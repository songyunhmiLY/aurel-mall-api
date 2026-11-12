import tseslint from 'typescript-eslint';

const banBusinessClock = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
      message: '业务时间必须经过 ClockService，不要调用 Date.now()。',
    },
    {
      selector: "NewExpression[callee.name='Date']",
      message: '业务时间必须经过 ClockService，不要直接 new Date()。',
    },
  ],
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/common/clock/**/*.ts', 'src/**/*.spec.ts'],
    rules: banBusinessClock,
  },
);
