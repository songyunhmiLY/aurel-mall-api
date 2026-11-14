/** @type {import('jest').Config} */
module.exports = {
  rootDir: '../..',
  testRegex: 'test/integration/.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  testEnvironment: 'node',
  clearMocks: true,
  globalSetup: '<rootDir>/test/integration/support/global-setup.js',
  testTimeout: 30000,
};
