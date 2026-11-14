/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  testEnvironment: 'node',
  clearMocks: true,
  // 集成测试需要真实 MySQL，只通过 npm run test:integration 单独运行。
  testPathIgnorePatterns: ['/node_modules/', 'test/integration/'],
};
