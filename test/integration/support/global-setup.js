/**
 * 集成测试全局准备：检查环境变量并执行数据库迁移。
 * 迁移完成后测试文件再负责清库与初始化根账户。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');
const { execSync } = require('node:child_process');

module.exports = async function globalSetup() {
  const url = process.env.INTEGRATION_DATABASE_URL;
  if (!url) {
    throw new Error(
      '集成测试需要指向真实 MySQL 的连接串。\n' +
        '先启动测试库：docker compose -f docker-compose.test.yml up -d\n' +
        '再设置环境变量后运行：\n' +
        '  INTEGRATION_DATABASE_URL="mysql://aurel:aurel_test_password@127.0.0.1:3307/aurel_mall_test" npm run test:integration',
    );
  }
  if (!/^mysql:\/\//.test(url)) {
    throw new Error('INTEGRATION_DATABASE_URL 必须是 mysql:// 连接串');
  }
  const root = path.join(__dirname, '..', '..', '..');
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
  });
};
