# 全链路集成测试（真实 MySQL）

单元测试跑内存库（`npm test`），这套测试跑**真实 MySQL**：验证 Schema 约束、唯一索引、
行锁、`$transaction` 隔离，以及 支付 → 入座 → 报单 → 奖励 → 钱包 → 提现 → 退款
整条链路在真实数据库上的行为。微信网关仍是测试替身，沙箱路径代表"微信已成功"。

## 本机 / 服务器运行步骤

### 1. 启动测试库

```bash
cd aurel-mall-api
docker compose -f docker-compose.test.yml up -d
```

启动 MySQL 8.4（宿主机 3307 端口）和 Redis（6380 端口），与开发栈错开，
两者可以同时运行。数据卷独立（`mysql_test_data` / `redis_test_data`）。

### 2. 跑集成测试

```bash
INTEGRATION_DATABASE_URL="mysql://aurel:aurel_test_password@127.0.0.1:3307/aurel_mall_test" \
  npm run test:integration
```

- 全局准备会先执行 `prisma migrate deploy`（把迁移应用到测试库），然后每个用例前清空业务表。
- 缺少 `INTEGRATION_DATABASE_URL` 时直接报错，不会连错库。
- `--runInBand` 串行执行：用例之间互相清库，不能并行。

### 3. 远程服务器上的数据库（可选）

如果测试库在远程服务器上，把连接串里的 `127.0.0.1:3307` 换成服务器地址即可。
不要把生产库当测试库用：这套测试会 TRUNCATE 所有业务表。

### 4. 用完关闭

```bash
docker compose -f docker-compose.test.yml down        # 保留数据卷
docker compose -f docker-compose.test.yml down -v     # 连数据卷一起删
```

## 覆盖的场景

| 用例 | 链路 |
| --- | --- |
| startup | 注册 → 绑定邀请 → 下单 → 积分+微信沙箱支付 → 结算（扣库存/入座/报单/奖励）→ 重复回调幂等（真实唯一索引） |
| mall | 会员商城混合支付（消费金+可提现+微信）→ 发货 → 退款申请 → 财务审核通过 → 三账户资金回收 + 微信退款出账 |
| withdrawal | KYC 实名 + 银行卡 → 提现申请（冻结）→ 打款（手续费、现金出账）→ 驳回路径解冻 |
| compensation | 取消订单后迟到支付成功 → 登记补偿 → 定时重试复活订单（完整结算事务跑在真实 DB 上） |

## 与单元测试的关系

单元测试（174+ 用例）不需要 Docker，`npm test` 随时可跑；这套集成测试只在
有真实数据库的环境运行（本地 Docker 或服务器）。CI 里建议两套都跑。
