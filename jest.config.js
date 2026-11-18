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
  // 用例里会跑 argon2 哈希，满并发时单个用例可能超过默认的 5 秒。
  // 单跑能过、全量偶尔超时的那种失败就来自这里。
  testTimeout: 20000,
  // 集成测试需要真实 MySQL，只通过 npm run test:integration 单独运行。
  testPathIgnorePatterns: ['/node_modules/', 'test/integration/'],
};
