# 奥瑞尔经销商城 API

经销商城后端。当前包含工程骨架、业务时钟、管理员登录、小程序登录、实名、收货地址、商品上下架，以及微信支付下单与回调。购物车、下单、支付扣款、提现、奖励结算和消息推送还没做。

同级仓库：

- `aurel-mall-admin`：管理后台
- `aurel-mall-uniapp`：小程序

## 技术栈

- Node.js 22（见 `.nvmrc`，不要假设机器上的全局 Node 版本）
- NestJS + TypeScript（strict）
- MySQL 8.4、Redis 7
- Prisma 6（迁移；以后树查询可以用 `$queryRaw` 写递归 SQL）
- BullMQ（队列占位，连 Redis）
- ESLint + Prettier

金额一律用整数**分**（1 元 = 100 分），不要用浮点元。比例用**万分比**，`10000` = 100%。

## 在远程 Linux 上用 Docker 跑整套

数据库和 Redis 跑在 Docker 里，不需要在 Windows 上安装 MySQL、Redis 或 Node。远程主机装好 Docker 与 Compose 插件后：

```bash
git clone <本仓库>
cd aurel-mall-api
cp .env.example .env
```

部署前请修改 `.env` 里的数据库密码和两个 JWT 占位密钥。密码请只用字母和数字，因为 API 的连接串会直接拼进 URL。

```bash
docker compose up -d --build
```

这条命令会启动 MySQL、Redis 和 API。数据在命名卷 `mysql_data`、`redis_data` 里。API 入口脚本会先执行 `prisma migrate deploy`，再监听 `3000`。

健康检查：

```bash
curl http://127.0.0.1:3000/api/v1/health
```

正常时 HTTP 200，JSON 形如 `{ "code": 0, "message": "ok", "data": { ... } }`。`data.clock` 里有当前业务时间、来源（`real` 或 `override`），以及 Asia/Shanghai 的本日、本月起点。

默认端口：API `3000`，MySQL `3306`，Redis `6379`。远程机器请用安全组限制 3306 和 6379，不要对公网裸奔。容器时区设为 `Asia/Shanghai`，但业务时间仍以 `ClockService` 为准，不依赖数据库的 `NOW()`。

只停 API、留下数据库：

```bash
docker compose stop api
```

## 在宿主机上改代码

远程或本机若要直接跑 Nest 而不是跑容器里的 API，用 nvm 或 fnm 读取 `.nvmrc`，不要用系统里随便一个 Node。

nvm：

```bash
nvm install
nvm use
```

fnm：

```bash
fnm install
fnm use
```

然后：

```bash
npm ci
cp .env.example .env
docker compose up -d mysql redis
npx prisma migrate deploy
npm run start:dev
```

`.env` 里的 `DATABASE_URL` / `REDIS_URL` 指向 `127.0.0.1`，给宿主机进程用。容器里的 API **不读这两行**，Compose 会把它们改写成服务名 `mysql` 和 `redis`。两边同时占 3000 端口时，先 `docker compose stop api`。

常用脚本：`npm test`、`npm run lint`、`npm run build`。

## 目录

```
src/
  main.ts                 # 监听 0.0.0.0:3000，前缀 /api/v1
  app.module.ts
  config/                 # 环境变量与锁定配置
  common/
    clock/                # 唯一业务时钟
    http/                 # 统一响应、异常过滤器
    auth/                 # 管理员登录与小程序会话
    prisma/
    redis/
  modules/
    health/
    users/                # 小程序登录、根账户、实名、地址
    catalog/              # 创业专区与会员商城
    orders/               # 订单占位
    payments/             # 微信支付下单、回调、商户配置
    wallet/               # 钱包占位
    cms/                  # Banner / 文章 / 滚动条占位
    rewards/              # 奖励，以及 trees、filing、positions、red-packet
    settings/             # 仅营销经理门槛 T
  jobs/                   # BullMQ 占位队列
prisma/schema/            # 多文件 schema，无外键
docs/er.md                # 逻辑 ER 图
```

一个文件只放一类东西（模块、控制器、服务、DTO）。跨模块的代码放在 `src/common/` 或 `src/config/`。业务时间禁止散落 `new Date()` / `Date.now()`，ESLint 会拦。

## 接口约定

- 前缀：`/api/v1`
- 成功：`{ "code": 0, "message": "ok", "data": ... }`
- 失败：HTTP 状态与 `code` 相同，`message` 为原因，`data` 一般为 `null`
- 健康检查：`GET /api/v1/health`

对外业务路由包括健康检查、时钟、管理员登录、小程序登录、实名、收货地址、商品，以及微信支付。购物车、下单、库存扣减和奖励结算还没有接口。JSON 里的 bigint 编号是十进制字符串。

## 认证

小程序的正式登录键是 `user_identities` 里 `provider = wechat_mini` 的 openid，不是手机号。同一用户还可以再挂别的身份。`wechat_oa`、`wechat_web`、`sms_phone` 只预留，分别留给以后的公众号 OAuth、网站应用 OAuth 和短信登录，本阶段不实现。不同微信入口的 openid 不是同一人；`unionid` 只留在对应身份上，不用来合并账号。

管理端只有一种管理员角色，权限相同，可以有多个账户。登录在后端校验用户名和密码，密码用 argon2id 存储。没有角色表，也没有权限矩阵。

- `POST /api/v1/admin/auth/login`，body：`{ "username": "...", "password": "..." }`
- 成功时 `data` 含 `token`、`tokenType: "Bearer"`、`expiresAt` 和 `admin`（`id`、`username`、`displayName`）。令牌有效期 12 小时，用 `JWT_ADMIN_SECRET` 做 HS256。
- 失败时 HTTP 401，`message` 为「用户名或密码错误」。停用账户同样失败，不签发令牌。
- 管理端路由带 `Authorization: Bearer <token>`。守卫会再查库，确认账户仍然是 `active`。

初始管理员不要把密码写进仓库。在 `.env` 里同时填写 `ADMIN_BOOTSTRAP_USERNAME` 和 `ADMIN_BOOTSTRAP_PASSWORD`（8 到 128 位）后启动：若该用户名还不存在，就创建一次。已存在则跳过，不会改密码。两个变量都留空则不创建。要再加一名管理员，把这两个变量改成新账户后重启，旧账户保留。`ADMIN_BOOTSTRAP_DISPLAY_NAME` 可空，空则显示名等于用户名。

## 小程序登录

`WECHAT_MINI_APP_ID` 和 `WECHAT_MINI_APP_SECRET` 来自环境变量。留空时小程序登录返回 503，文案为「小程序未配置」。

- `POST /api/v1/auth/mini/login`，body：`{ "code": "<wx.login 的 code>" }`
- 服务端用这个 code 向微信换 openid。已有 `wechat_mini` 身份就登录，没有就创建用户。停用用户返回 401「账号已停用」，不签发令牌。
- 成功时 `data` 含 `token`、`tokenType: "Bearer"`、`expiresAt` 和 `user`。`user` 有 `id`、`nickname`、`avatarUrl`、`phone`、`inviteCode`、`member`、`status`。
- 令牌用 `MINI_PROGRAM_TOKEN_SECRET` 做 HS256，有效期 7 天。这是会话时长，不是业务期限。
- 需要登录的路由带 `Authorization: Bearer <token>`。守卫会再查库，停用或过期都是 401。

`POST /api/v1/auth/mini/phone` 需要用户令牌，body：`{ "code": "<手机号快速验证的 code>" }`。服务端向微信换手机号，写到当前用户的 `phone`。成功时 `data` 为 `{ "phone": "13800138000" }`。这个号码不是登录键，也不会把两个用户合并。

## 开发预览

`ALLOW_PREVIEW_AUTH` 默认 `false`。是否接受预览登录只看这个开关，不看主机名、来源 IP 或其他密钥。

- 关闭时，`POST /api/v1/auth/preview/login` 返回 403，文案含「已忽略」，不创建用户。
- 打开时，body：`{ "subject": "alice" }`。`subject` 是 1 到 64 位字母、数字、点、下划线或中划线。按这个标识查找或创建预览用户，并签发和正式登录一样的用户令牌。
- 这只给 uni-app H5 预览切换身份。它不是正式 H5 登录，不走微信网站应用 OAuth，也不代替 `wx.login`。

## 根账户和会员

进程启动时，如果还没有官方根账户，就创建一次。它自动是会员，同时是邀请树和市场树的根，邀请码是 `ROOT`，不需要下单。不会用这种方式创建其他会员。其他用户要等以后创业专区购买成功后再入座。本阶段不实现安置算法。

有市场树席位才是会员。根账户有席位。非会员可以浏览创业专区，调用会员商城列表或详情时返回 403，文案为「非会员不能浏览会员商城」。

停用只把 `users.status` 改成 `disabled`，因此不能登录。不取消会员，也不删除市场树席位。

## 实名

实名只在提现前需要。浏览、下单和消费账户划转不检查它。只收集姓名、18 位身份证号和手机号。没有证件照，没有人脸核验，也没有第三方征信。格式通过就记为 `verified`。

需要用户令牌：

- `GET /api/v1/me/kyc`
- `POST /api/v1/me/kyc`，body：`{ "realName": "张三", "idNumber": "11010119900307888X", "mobile": "13800138000" }`

还没提交时 `verified` 为 `false`，其余字段为 `null`。通过后 `data` 含 `verified`、`status: "verified"`、`realName`、`idNumber`、`mobile`、`submittedAt`、`updatedAt`。身份证末位 `x` 会存成大写。姓名为空、身份证不是 18 位或手机号不是 `1` 开头的 11 位数字时返回 400，不落库。

后续提现要调用 `KycService.isVerified(userId)`，不要自己猜字段。

## 收货地址

需要用户令牌。一个用户可以有多条地址。

- `GET /api/v1/me/addresses`
- `POST /api/v1/me/addresses`
- `PUT /api/v1/me/addresses/:id`
- `DELETE /api/v1/me/addresses/:id`，`data` 为 `{ "id": "..." }`
- `POST /api/v1/me/addresses/:id/default`

写入 body：`contactName`、`contactPhone`、`province`、`city`、`district`、`detail`、`isDefault`。设为默认时，该用户其他地址的默认标记会被清掉。删除后不会自动另选一条默认地址。只能改自己的地址。

## 商品

专区是 `startup`（创业专区）和 `mall`（会员商城）。每个商品恰好一个 SKU，没有款式。金额是分。状态是 `draft` / `on` / `off`。用户接口只返回 `on`。本阶段管理端可以设置库存，但不会因为下单去扣。没有购物车。

创业专区售价固定为锁定单价 N（`STARTUP_ZONE_UNIT_PRICE_FEN`）。保存时写成 N。如果请求里的售价不是 N，仍然按 N 保存，并在 `warnings` 里说明。创业专区不使用 PV，提交 PV 会返回 400。

会员商城同时保存 `priceFen` 和 `pvFen`。`pvFen` 按分计：`100` = 1 PV = 1 元，它不是售价。PV 大于售价时 `warnings` 为 `["PV 大于售价"]`，数据照常保存。

运费是商品上的 `freightFen`，没有地区费率。封面 `coverUrl` 和附图 `imageUrls` 都是 http(s) URL，由管理端填写，没有上传服务。会员商城可以挂一个分类。

用户接口需要登录：

- `GET /api/v1/catalog/products?zone=startup|mall&categoryId=&page=&pageSize=`
- `GET /api/v1/catalog/products/:id`

返回 `id`、`zone`、`name`、`subtitle`、`body`、`coverUrl`、`imageUrls`、`freightFen`、`priceFen`、`stockQuantity`、`category`。只有商城带 `pvFen`。未上架或不存在是 404。`categoryId` 只对商城列表生效。

管理端需要管理员令牌：

- `GET /api/v1/admin/products?zone=&status=&categoryId=&page=&pageSize=`，包含草稿和下架
- `GET /api/v1/admin/products/:id`
- `POST /api/v1/admin/products`
- `PUT /api/v1/admin/products/:id`，不能改专区
- `POST /api/v1/admin/products/:id/shelf`，body：`{ "status": "on" | "off" }`
- `PUT /api/v1/admin/products/:id/stock`，body：`{ "quantity": 10 }`，把可售数量设成这个值
- `GET|POST /api/v1/admin/mall-categories`，创建 body：`{ "name": "分类", "sortOrder": 0 }`
- `PUT /api/v1/admin/mall-categories/:id`

创建 body 使用 `zone`、`name`、`subtitle`、`body`、`coverUrl`、`imageUrls`、`freightFen`、`priceFen`、`pvFen`、`categoryId`、`stockQuantity`、`status`。不传 `status` 时是 `draft`。商城必须带售价和 PV。创建和更新的 `data` 是 `{ "product": { ... }, "warnings": [] }`。管理端商品另外有 `status`、`pvFen`（创业专区为 `null`）、`skuId`、`categoryId`、`createdAt`、`updatedAt`。列表 `data` 是 `{ "items", "total", "page", "pageSize" }`，默认每页 20，最大 100。

## 管理端用户

需要管理员令牌。搜索条件都可空：`id` 精确，`nickname` 包含，`phone` 精确。

- `GET /api/v1/admin/users?id=&nickname=&phone=&page=&pageSize=`
- `GET /api/v1/admin/users/:id`
- `POST /api/v1/admin/users/:id/disable`
- `POST /api/v1/admin/users/:id/enable`
- `GET /api/v1/admin/users/:id/kyc`，形状和用户自己的实名接口相同；还没提交时 `verified` 为 `false`

用户字段：`id`、`status`、`nickname`、`avatarUrl`、`phone`、`inviteCode`、`member`、`kycVerified`、`createdAt`、`updatedAt`。`member` 为 true 表示有市场树席位。

## 时钟

业务上的“现在”只能走 `ClockService`（`src/common/clock/`）。落库的业务时间由它产生，不要依赖 MySQL `CURRENT_TIMESTAMP` / `NOW()`。

- 默认返回真实当前时间。
- 是否允许覆盖只由 `ALLOW_CLOCK_OVERRIDE` 决定，默认 `false`。不看主机名、来源 IP、局域网地址，也没有测试密钥。
- 开关为 `false` 时，设置和清除都返回 403，不写 Redis；即使 Redis 里已经有覆盖值，业务时间也不使用它。
- 开关为 `true` 时，任何调用方都可以通过下面的接口覆盖。覆盖值存在 Redis 键 `aurel:clock:override`。API 和以后的 BullMQ 任务通过同一个 `ClockService.now()` 读它。
- 日初、月初、业务日（`YYYY-MM-DD`）按 `Asia/Shanghai` 计算。中国无夏令时，按固定 UTC+8。
- 生产环境必须保持 `ALLOW_CLOCK_OVERRIDE=false`。

这是给以后测试控制台留的钩子，没有测试页面。

```bash
# 查看。开关关闭时 allowed 为 false，now 是真实时间。
curl http://127.0.0.1:3000/api/v1/internal/clock

# 设置。仅 ALLOW_CLOCK_OVERRIDE=true 时写入。
curl -X PUT -H 'Content-Type: application/json' \
  -d '{"iso":"2026-01-15T00:00:00.000Z"}' \
  http://127.0.0.1:3000/api/v1/internal/clock/override

# 清除。开关关闭时不会删掉 Redis 里的残留值，但业务时间也不读它。
curl -X DELETE http://127.0.0.1:3000/api/v1/internal/clock/override
```

## 锁定配置（需求 §1.1）

这些值放在 `docker-compose.yml` 和 `.env.example` 里，进程启动时读入并冻结。没有管理端修改接口，改了必须重启。不要写进 `admin_settings`。

| 含义                                   | 变量                                                                                              | 示例默认                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 创业专区单价 N                         | `STARTUP_ZONE_UNIT_PRICE_FEN`                                                                     | `100000`（1000.00 元，示例）            |
| 报单/结算可提现比例                    | `FILING_WITHDRAWAL_RATIO_BPS`                                                                     | `8000`（80%，示例）                     |
| 创业专区销售奖比例 R 及钱包拆分        | `STARTUP_SALES_AWARD_RATIO_BPS`、`_WITHDRAWABLE_BPS`、`_POINTS_BPS`                               | `1000` / `7000` / `3000`（示例）        |
| 创业专区积分奖比例 P 及拆分            | `STARTUP_POINT_AWARD_*`                                                                           | `500` / `0` / `10000`（示例）           |
| 商城销售奖比例 S 及拆分                | `MALL_SALES_AWARD_*`                                                                              | `800` / `7000` / `3000`（示例）         |
| 商城积分奖比例 Q 及拆分                | `MALL_POINT_AWARD_*`                                                                              | `300` / `0` / `10000`（示例）           |
| 职位分红份额档位                       | `POSITION_DIVIDEND_SHARE_TIERS`                                                                   | `leader:1,manager:2,director:3`（示例） |
| 每日红包计提占当日创业专区销售额       | `RED_PACKET_DAILY_ACCRUAL_BPS`                                                                    | `100`（1%，示例）                       |
| 红包轮次实付门槛 K                     | `RED_PACKET_ROUND_PAY_THRESHOLD_FEN`                                                              | `500000`（需求示例 5000 元）            |
| 每轮领取上限 C                         | `RED_PACKET_ROUND_CLAIM_CAP_FEN`                                                                  | `800000`（需求示例 8000 元）            |
| 联合创始人 / 工作室 / 运营团队分红比例 | `COFOUNDER_DIVIDEND_RATIO_BPS`、`STUDIO_DIVIDEND_RATIO_BPS`、`OPERATIONS_TEAM_DIVIDEND_RATIO_BPS` | `3000` / `2000` / `1000`（示例）        |

每组钱包拆分必须合计 `10000`，目标是可提现余额 `withdrawable` 和积分 `points`。对不上时进程拒绝启动。除 K、C 外，上表数字都是占位，不是已确认的产品规则。职位编码要以后和 `positions.code` 对上，目前不预置职位数据。

## 营销经理市场门槛 T

T **不是**锁定项。环境变量 `MARKETING_MANAGER_MARKET_THRESHOLD_DEFAULT` 只在 `admin_settings` 还没有键 `marketing_manager_market_threshold` 时写入一次。之后以数据库的值为准，重启不会覆盖。单位尚未确认。

需要管理员令牌：

- `GET /api/v1/admin/settings/marketing-manager-market-threshold`
- `PUT /api/v1/admin/settings/marketing-manager-market-threshold`，body：`{ "value": "10000" }`

## 微信支付

商户号、API 证书和 APIv3 密钥存在 `admin_settings`，由管理员接口写入，不写进代码或仓库。证书字段要同时贴上 `apiclient_cert.pem` 和 `apiclient_key.pem`。读取接口会打码 APIv3 密钥，并且不返回证书正文。三项都合法之后视为已配置。

- `GET /api/v1/admin/settings/wechat-pay`
- `PUT /api/v1/admin/settings/wechat-pay`，body 可只带要改的字段：`merchantId`、`apiCertificate`、`apiV3Key`
- `DELETE /api/v1/admin/settings/wechat-pay` 清空这三项，之后重新允许模拟成功

支付单挂在已有订单上。订单需要是 `pending_payment`，金额是订单的 `pay_amount_fen`（分）。本接口不创建商城订单，也不做消费账户、提现账户或积分账户的冻结和划扣，也不处理分账或二清。

- `POST /api/v1/payments/wechat/prepay`，body：`{ "orderId": "1", "appId": "wx...", "openid": "..." }`
- 未配齐商户资料时返回 `mode: "sandbox"`，不调用微信。再用 `POST /api/v1/payments/wechat/sandbox/succeed`，body：`{ "payNo": "..." }`，把该支付单标为成功，并把仍处于待支付的订单标为 `paid`。
- 已配齐时必须带 `appId`、`openid`，以及环境变量 `WECHAT_PAY_NOTIFY_URL`。接口向微信 JSAPI 下单，返回 `mode: "live"` 和小程序 `requestPayment` 需要的签名字段。
- 回调是 `POST /api/v1/payments/wechat/notify`。验签和解密使用已保存的商户资料和微信支付平台证书。成功且金额、商户号一致时，支付单变为 `success`，订单从 `pending_payment` 变为 `paid`。`PAYERROR` / `CLOSED` / `REVOKED` 把仍在待支付的支付单标为 `failed`。`success` 之后不再改回失败；若之前已是 `failed` 又收到 `SUCCESS`，改为成功。重复通知不会重复写支付时间。
- 商户资料已配齐时，模拟成功接口返回 403。

回调响应是微信要求的 `{ "code": "SUCCESS" | "FAIL", "message": "..." }`，不套本系统的 `{ code, message, data }`。

## 数据库

Schema 在 `prisma/schema/`，初始迁移在 `prisma/schema/migrations/`。没有强制外键。逻辑关系和基数见 [docs/er.md](docs/er.md)，同目录有 SVG / PNG。

表按域拆开：用户与身份、地址、管理员、商品与库存、订单与支付、钱包流水、Banner / 文章 / 滚动条、邀请树、市场树、报单、奖励流水、职位、红包、管理员配置。

状态字段是字符串，由应用写入，数据库不设业务默认值。用户状态是 `active` / `disabled`，商品状态是 `draft` / `on` / `off`，实名状态是 `verified`。管理员状态是 `active`，订单状态使用 `pending_payment` / `paid` / `closed`，微信支付状态使用 `pending` / `success` / `failed`。其余注释里的状态仍是预留。
