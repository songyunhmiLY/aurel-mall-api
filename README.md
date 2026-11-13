# 奥瑞尔经销商城 API

经销商城后端。当前包含工程骨架、业务时钟、管理员登录、小程序登录、实名、收货地址、商品上下架、订单支付、三个钱包账户、消费账户划转、提现审核、商城退款审核、创业专区支付成功后的入座、报单与全网公排、创业专区和商城奖励、月度职位分红、创业团队页、福利专场（抢红包）、联合创始人、工作室补贴、运营团队分红、管理端运营总览、首页轮播图、资讯知识和滚动字幕，以及微信支付下单与回调。购物车和消息推送还没做。

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
    orders/               # 下单、支付拆分、发货
    payments/             # 微信支付下单、回调、商户配置
    wallet/               # 积分、可提现、消费账户、划转、提现
    cms/                  # 首页轮播图、资讯和知识、滚动字幕
    rewards/              # 报单、奖励、市场业绩、职位分红、创业团队、福利专场
    cofounder/            # 联合创始人开通、分红和取消审核
    studio/               # 工作室指定、取消和补贴
    ops-team/             # 运营团队指定、改派、取消和分红
    ops/                  # 管理端运营总览（只读）
    settings/             # 营销经理门槛 T（下月生效）
  jobs/                   # 按业务时钟跑每日报单检查、职位分红、前一日红包和联合创始人定期分配
prisma/schema/            # 多文件 schema，无外键
docs/er.md                # 逻辑 ER 图
```

一个文件只放一类东西（模块、控制器、服务、DTO）。跨模块的代码放在 `src/common/` 或 `src/config/`。业务时间禁止散落 `new Date()` / `Date.now()`，ESLint 会拦。

## 接口约定

- 前缀：`/api/v1`
- 成功：`{ "code": 0, "message": "ok", "data": ... }`
- 失败：HTTP 状态与 `code` 相同，`message` 为原因，`data` 一般为 `null`
- 健康检查：`GET /api/v1/health`

对外业务路由包括健康检查、时钟、管理员登录、小程序登录、实名、收货地址、商品、钱包余额和流水、消费账户划转、提现、商城退款、订单支付、发货、微信支付、创业团队、福利专场、联合创始人、首页轮播图、资讯知识和滚动字幕，以及管理端的邀请关系、市场树、报单、奖励、职位分红、会员钱包查询、福利专场、联合创始人、工作室、运营团队、运营总览和首页内容。购物车还没有接口。会员端没有工作室开通接口，也没有运营团队开通或身份入口。会员端没有幸运返还、奖励明细、我的职位或邀请关系列表，这些金额出现在可提现分类里，关系和管理明细只给管理端。会员端福利专场只返回能不能报名、今天有没有报过名，不返回上限和已领金额。会员端联合创始人身份只出现在联合创始人入口，不出现在登录资料里。运营团队分红只出现在可提现账户，不出现在登录资料里。会员端也不提供运营总览，不能靠这个接口轮询资金。会员端首页轮播、字幕和资讯不要求会员资格。JSON 里的 bigint 编号和金额里的 bigint 都是十进制字符串。

## 认证

小程序的正式登录键是 `user_identities` 里 `provider = wechat_mini` 的 openid，不是手机号。同一用户还可以再挂别的身份。`wechat_oa`、`wechat_web`、`sms_phone` 只预留，分别留给以后的公众号 OAuth、网站应用 OAuth 和短信登录，本阶段不实现。不同微信入口的 openid 不是同一人；`unionid` 只留在对应身份上，不用来合并账号。

管理端只有一种管理员角色，权限相同，可以有多个账户。登录在后端校验用户名和密码，密码用 argon2id 存储。没有角色表，也没有权限矩阵。

- `POST /api/v1/admin/auth/login`，body：`{ "username": "...", "password": "..." }`
- 成功时 `data` 含 `token`、`tokenType: "Bearer"`、`expiresAt` 和 `admin`（`id`、`username`、`displayName`）。令牌有效期 12 小时，用 `JWT_ADMIN_SECRET` 做 HS256。
- 失败时 HTTP 401，`message` 为「用户名或密码错误」。停用账户同样失败，不签发令牌。
- 管理端路由带 `Authorization: Bearer <token>`。守卫会再查库，确认账户仍然是 `active`。

初始管理员不要把密码写进仓库。在 `.env` 里同时填写 `ADMIN_BOOTSTRAP_USERNAME` 和 `ADMIN_BOOTSTRAP_PASSWORD`（8 到 128 位）后启动：若该用户名还不存在，就创建一次。已存在则跳过，不会改密码。两个变量都留空则不创建。要再加一名管理员，把这两个变量改成新账户后重启，旧账户保留。`ADMIN_BOOTSTRAP_DISPLAY_NAME` 可空，空则显示名等于用户名。

## 运营总览

管理端第一屏。只读，可以重复调用。30 秒刷新由客户端自己请求，服务端不推送。对齐官方需求 §18.3，不改现金流水的写入规则，也不改报单、退款和提现的互斥。不返回成本或利润，也不返回职位分红金额。

需要管理员令牌：

- `GET /api/v1/admin/ops/overview`
- 查询参数 `period`：`today`（默认）、`yesterday`、`last7days`、`month`、`custom`
- `custom` 必须同时给 `from` 和 `to`。`YYYY-MM-DD` 按 Asia/Shanghai 自然日，含首尾两天。带时区的 ISO 时刻按 `[from, to)`，右端不含。不能超过 370 个自然日。没有时区的时刻返回 400。

`data.period` 有 `key`、`timezone`（固定 `Asia/Shanghai`）、`from`、`until`（ISO，`until` 不含）、`fromBizDate`、`untilBizDate`。`today`、`yesterday`、`last7days` 都含业务时钟的当天。`last7days` 是含当天在内的 7 个自然日。`month` 是时钟所在的整个自然月，从 1 日 00:00 到下月 1 日 00:00。

金额合计是 bigint，JSON 里是十进制字符串。笔数、件数、序号、`delta` 是 number。编号是十进制字符串。时间是 ISO 字符串。订单上的单笔 `*Fen` 在订单接口里仍是 number；这里的应付和现金都是多笔合计，所以用字符串。

`data.kpis`：

- `registeredUsers`：当前注册用户数，含尚未入座的人。number。
- `members`：当前已入座会员数（`seated`）。number。
- `newRegistrations`、`newMembers`：`count` 是本区间的新增注册、新增入座。`previousDay` 是区间起点所在上海日的前一个自然日，`previousDayCount` 是那一整天的人数，`delta` 是 `count - previousDayCount`。多日区间仍然只和这一个自然日比较。
- `wechatCash`：`cashInFen` 是已支付订单的微信渠道金额，`cashRefundedFen` 是现金流水里的微信实退，`netFen` 是两者之差。积分、可提现、消费账户的抵扣算进应付，不算进微信实收。
- `pendingWithdrawals`：当前待审核提现的 `count` 和 `amountFen`。不按区间截断。

`data.trend` 是区间里每个上海自然日一条：`bizDate`、`startupPayableFen`、`mallPayableFen`。只统计状态为 `paid` 或 `shipped`、且 `paidAt` 落在区间内的订单。应付是订单 `payAmountFen`（商品金额加该单运费）。没有订单的日期金额为 `"0"`。

`data.composition.startup` 和 `data.composition.mall`：

- `orderCount`、`itemQuantity`、`payableFen`：同上，已支付订单。商城应付含运费，创业专区若该单收了运费也同样含在 `payAmountFen` 里。
- `pendingShipmentCount`：区间内 `paidAt`、状态仍是 `paid` 的订单数。
- `shippedCount`：区间内 `shippedAt`、状态为 `shipped` 的订单数。
- `closedCount`：区间内 `closedAt`、状态为 `closed` 的订单数。关闭未支付的订单只出现在这里，不进入应付和微信实收。

`data.composition.cash`：

- `wechatCashInFen`、`wechatCashRefundedFen`、`netCashFen`：与顶部微信现金相同。净额可以是负数，表示本区间的实退多于实收。
- `withdrawalPayoutFen`：现金流水里 `withdrawal_payout` 的实付合计，不从净额里扣。
- `cofounderActivationFen`：联合创始人开通里实际走微信的收款，来自现金流水 `inflow` / `cofounder_activation`。不并进商品实收，也不把可提现账户里的 `cofounder` 入账当成现金。没有开通收款时为 `"0"`。

`data.withdrawals`：

- `pendingReview`：与顶部待审核提现相同。
- `completedPayouts`：`count` 和 `amountFen` 来自本区间已打款结算（`amountFen` 是申请金额）。`payoutFen` 与现金流水里的提现实付相同。
- `pendingRefunds.count`：当前待审核商城退款笔数。申请时还没有审定退款额。
- `mutualExclusion`：有待审核提现的会员不能同时申请商城退款，有待审核退款的会员不能同时提现。`withdrawalBlocksRefundUserCount` 和 `refundBlocksWithdrawalUserCount` 是这两边的会员数。`bothPendingUserCount` 是同一个人两边都待审核的人数，按现有互斥应为 `0`。

`data.wallets` 是会员负债，不是现金账。`withdrawable`、`points`、`consumption` 各有 `availableFen`（余额减冻结）和 `frozenFen`。`withdrawalAppliedUnpaidFen` 是已申请、尚未打款的提现金额，单独列出，不从冻结里再减一次。

`data.filing` 不随 `period` 改变，展示业务时钟的当天和当前公排：

- `todayFiledCount`、`todayBizDate`：当天已完成的报单笔数。每个会员每个自然日最多一笔。
- `currentSequence`：全网公排当前序号。还没有报单时为 `0`。number。
- `nextLuckyReturnSequence`：下一个会触发幸运返还的序号，即严格晚于当前序号的下一个 5 的倍数。当前为 `0` 或 `5` 时，下一个分别是 `5` 和 `10`。
- `nextLuckyReturnBeneficiarySequence`：那个序号要结算的公排序号 k。序号 5 结算序号 1。
- `latestLuckyReturn`：最近一笔幸运返还。没有时为 `null`。字段有 `id`、`triggerSequence`、`beneficiarySequence`、`beneficiaryFilingId`、`beneficiaryUserId`、`pointsFen`、`withdrawableFen`、`settledAt`。编号和金额是字符串。
- `backlogCount`：尚未报出的创业子单数，留给每日自动报单检查。检查时刻是锁定配置 `dailyCheckTime`，默认 `00:01`，本接口不修改它。

`data.organization`：

- `seatedMembers`、`nonMembers`：已入座和未入座，两者之和等于注册用户数。
- `membersWithThreeMarkets`：直接下级市场已经有 3 个的会员数。
- `positionQualifications`：职位模块已存在，所以 `available` 为 `true`。`performanceMonth` 是当前上海自然月，`thresholdFen` 是这个月已经生效的门槛 T。改 T 只从下月生效，这里不用下月的 T。`counts` 里每一档有 `positionCode`、`positionName`、`qualifiedCount`。显示名沿用营销经理、高级经理、营销总监、高级总监、首席。人数是达到该档资格的会员数，不按分红池剔除更高职位，也不给分红金额。

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

`POST /api/v1/auth/mini/login` 和 `POST /api/v1/auth/preview/login` 都不接收邀请码。多传 `inviteCode` 会返回 400。登录只建立会话；邀请关系要另调下面的接口。

## 填写邀请码

可以先用小程序或预览登录拿到令牌。注册要等用户提交一名**未停用会员**的邀请码才算完成。这一次写入邀请上级，不写席位。关系只形成一次，以后入座不会改上级。

需要用户令牌：

- `POST /api/v1/me/inviter`，body：`{ "inviteCode": "000000" }`

成功时 `data` 为 `{ "inviteCode": "000000", "inviterId": "1" }`。`inviteCode` 是提交的 6 位数字码，`inviterId` 是邀请人的用户 id。此时用户还不是会员，自己的 `inviteCode` 仍是 `null`，也没有席位。

邀请码是 6 位数字，必须和库里的值完全一致。根账户的码固定是 `000000`，只留给根账户，方便测试时把新账号显式挂到根下面。其他会员第一次入座时得到另一个 6 位数字码，不会是 `000000`。非会员没有邀请码，不能当邀请人。

登录不会写邀请上级，也不会在用户没提交邀请码时默认挂到根账户。没调用这个接口的用户仍然没有邀请上级；这时下创业专区订单返回 400「缺少邀请关系」。已经写过的上级不会被改写。根账户自己不调用这个接口。

错误：

- 400「邀请码不正确」：空、格式不对，或没有这个码
- 400「非会员不能作为邀请人」
- 400「邀请人已停用」：会员已停用。停用不清邀请码，也不能拿来注册新人
- 400「不能填写自己的邀请码」
- 409「邀请关系已存在」：已经写过上级，不能再改

## 根账户和会员

进程启动时，如果还没有官方根账户，就创建一次。它自动是会员，同时是邀请树和市场树的根，邀请码是 `000000`，不需要下单，也不走填写邀请码。若库里还留着旧码 `ROOT`，启动时改成 `000000`。不会用这种方式创建其他会员。其他用户只有显式填写邀请码之后，才有邀请上级；创业专区支付成功后再入座。

有市场席位才是会员。这个标记同时写在用户行的 `member` 和 `seated` 上，两者一起更新。根账户启动时就是会员。非会员可以浏览创业专区，调用会员商城列表或详情时返回 403，文案为「非会员不能浏览会员商城」。

停用只把 `users.status` 改成 `disabled`，因此不能登录。不取消会员，也不删除市场席位。`member` 和 `seated` 保持不变。

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

专区是 `startup`（创业专区）和 `mall`（会员商城）。每个商品恰好一个 SKU，没有款式。金额是分。状态是 `draft` / `on` / `off`。用户接口只返回 `on`。支付成功时按购买数量扣库存；下单时库存不够会拒绝。没有购物车。

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

| 含义                     | 变量                                                                                                             | 示例默认                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创业专区单价 N           | `STARTUP_ZONE_UNIT_PRICE_FEN`                                                                                    | `100000`（1000.00 元）                                                                                                                                |
| 报单结算可提现比例       | `FILING_WITHDRAWAL_RATIO_BPS`                                                                                    | `2000`（20%）                                                                                                                                         |
| 每日报单检查时间         | `FILING_DAILY_CHECK_TIME`                                                                                        | `00:01`（Asia/Shanghai，HH:mm）                                                                                                                       |
| 创业专区销售奖比例 R     | `STARTUP_SALES_AWARD_RATIO_BPS`                                                                                  | `500`（5%）                                                                                                                                           |
| 创业专区见点奖比例 P     | `STARTUP_POINT_AWARD_RATIO_BPS`                                                                                  | `200`（2%）                                                                                                                                           |
| 创业奖钱包拆分           | `STARTUP_AWARD_WITHDRAWABLE_BPS`、`_POINTS_BPS`、`_CONSUMPTION_BPS`                                              | `8500` / `500` / `1000`                                                                                                                               |
| 商城销售奖比例 S         | `MALL_SALES_AWARD_RATIO_BPS`                                                                                     | `500`（5%）                                                                                                                                           |
| 商城见点奖比例 Q         | `MALL_POINT_AWARD_RATIO_BPS`                                                                                     | `200`（2%）                                                                                                                                           |
| 商城奖和职位分红钱包拆分 | `MALL_AWARD_WITHDRAWABLE_BPS`、`_POINTS_BPS`、`_CONSUMPTION_BPS`                                                 | `8500` / `1000` / `500`                                                                                                                               |
| 职位分红池，从低到高     | `POSITION_DIVIDEND_POOL_BPS`                                                                                     | `marketing_manager:800,senior_manager:600,director:500,senior_director:400,chief:300`                                                                 |
| 福利专场当日奖池比例     | `RED_PACKET_DAILY_ACCRUAL_BPS`                                                                                   | `300`（3%，需求示例）                                                                                                                                 |
| 福利专场实付门槛 K       | `RED_PACKET_ROUND_PAY_THRESHOLD_FEN`                                                                             | `500000`（需求示例 5000 元）                                                                                                                          |
| 福利专场每轮领取上限 C   | `RED_PACKET_ROUND_CLAIM_CAP_FEN`                                                                                 | `800000`（需求示例 8000 元）                                                                                                                          |
| 联合创始人分红比例       | `COFOUNDER_DIVIDEND_RATIO_BPS`，可选 `COFOUNDER_STARTUP_DIVIDEND_RATIO_BPS`、`COFOUNDER_MALL_DIVIDEND_RATIO_BPS` | `200`（2%，官方示例）。两条可选变量留空时都用前一项。原先示例 `3000` 是未结算占位                                                                     |
| 工作室补贴比例           | `STUDIO_STARTUP_SUBSIDY_RATIO_BPS`、`STUDIO_MALL_SUBSIDY_RATIO_BPS`                                              | `200` / `200`（各 2%，官方示例）。两条分开配置。原先的 `STUDIO_DIVIDEND_RATIO_BPS=2000` 是未结算占位，不再读取                                        |
| 运营团队分红比例         | `OPS_TEAM_STARTUP_DIVIDEND_RATIO_BPS`、`OPS_TEAM_MALL_DIVIDEND_RATIO_BPS`                                        | `500` / `700`（5% / 7%，官方示例）。两条分开配置。原先的 `OPERATIONS_TEAM_DIVIDEND_RATIO_BPS` 或 `OPS_TEAM_DIVIDEND_RATIO_BPS` 是未结算占位，不再读取 |
| 提现手续费               | `WITHDRAWAL_FEE_FEN`                                                                                             | `0`（示例，正式金额未确认）                                                                                                                           |

两组钱包拆分都是可提现、积分、消费三项，必须合计 `10000`。对不上，或每日检查时间不是 `HH:mm` 时，进程拒绝启动。创业专区的销售奖和见点奖共用创业奖拆分。商城销售奖、商城见点奖和职位分红共用商城拆分。职位池按配置顺序从低到高：第一档是营销经理，不与同时达到更高职位的人叠加；更高档包含同时达到更高职位的人。各档万分比不必合计 `10000`，没有合格会员的那一档留在系统里。

`FILING_DAILY_CHECK_TIME` 只在进程启动时读入，没有管理端修改接口，也不写入 `admin_settings`。福利专场用这同一个钟点结算前一个上海自然日，不另设时间。K、C 和奖池比例也只在启动时读入。联合创始人的两条分红比例、工作室的两条补贴比例、运营团队的两条分红比例同样只在启动时读入，管理端不能改。提现手续费按锁定配置在打款时扣除。启动时会按职位池编码写入 `positions`。已知编码的显示名是营销经理、高级经理、营销总监、高级总监、首席。启动时如果库里已经有旧显示名，会改成这五个。换成其他编码时显示名就是编码本身。

## 营销经理市场门槛 T

T **不是**锁定项。单位是分，比较的是市场里创业专区已支付订单的应付金额（含运费）。环境变量 `MARKETING_MANAGER_MARKET_THRESHOLD_DEFAULT` 只在还没有任何生效月份时，作为当前上海自然月的首次值写入 `market_threshold_revisions`。若库里还留着旧键 `marketing_manager_market_threshold`，首次迁移用那个字符串。之后以修订记录为准，重启不会覆盖。

管理端修改只写入**下一个**自然月。当月资格仍用改之前的 T。某月采用 `effectiveMonth` 小于等于该月的最新一行。

需要管理员令牌：

- `GET /api/v1/admin/settings/marketing-manager-market-threshold`
- `PUT /api/v1/admin/settings/marketing-manager-market-threshold`，body：`{ "value": "2000000" }`

`data` 为 `{ "month", "thresholdFen", "nextMonth", "nextThresholdFen" }`。金额是十进制字符串。示例 `2000000` 表示 20000.00 元。

## 福利专场（抢红包）

首页入口的文案和图片由管理员配置，存在 `admin_settings` 的 `welfare_entry_copy`、`welfare_entry_image_url`。K、C 和奖池比例不在这个接口里。轮播图、资讯和滚动字幕是另一套首页内容，见下文。

需要用户令牌：

- `GET /api/v1/me/welfare/entry`，`data` 为 `{ "copy", "imageUrl" }`。未配置时文案是空字符串，图片是 `null`。
- `GET /api/v1/me/welfare`，`data` 只有 `{ "eligible", "signedUpToday" }`。不返回本轮上限、已领金额或剩余额度。
- `POST /api/v1/me/welfare/signups`，无请求体。成功时 `data` 同样只有这两个字段。同一上海自然日重复点击仍返回成功，只保留一行报名。

`eligible` 为 false 时，客户端显示「不具备资格」，按钮不可点。这时调用报名返回 HTTP 403，`message` 为「不具备资格」。非会员也是这个结果。停用账号沿用登录守卫，返回 401「登录已失效」。

资格：已开轮数 = floor(累计创业专区已支付订单的 `wechat_fen` / K)。当前上限 = 已开轮数 × C。累计已领金额不按轮清零。已领金额小于当前上限，并且用户是未停用会员，才可以报名。商城订单不计入。积分账户和可提现账户抵扣的部分不计入；一笔订单既有钱包又有微信支付时，只累加 `wechat_fen`。后来的创业专区订单继续累加，不因跨天或拆成多笔而作废。买一件创业装可以成为会员，但实付未满 K 时仍然没有资格。`wechat_fen` 是拆分后的微信支付金额，运费若由微信支付会留在里面，因此计入实付；奖池不用这个字段。K 为 0 时不开轮。这是避免除以零的实现选择，正式规则没有写 K = 0。

报名立即生效，不等到凌晨。要领某一天的红包，必须在该上海自然日结束前点报名。

结算挂在已有的每日任务上，使用启动时读入的 `FILING_DAILY_CHECK_TIME`（默认上海时间 00:01）。到点后结算前一个自然日。00:01 之前不结算昨天。00:00 到 00:01 之间的报名算新的一天，不进入昨天的分配。任务可以补跑错过的日子。同一天已经写下 `settled_at` 后再次执行不会重复入账。

当天奖池 = floor(当日创业专区已支付订单的 `goods_total_fen` × 万分比 / 10000)。`goods_total_fen` 就是销售奖使用的商品金额 N × 件数，含钱包支付的货款，不含运费，不含商城订单。状态只取 `paid` 和 `shipped`。没人报名时，奖池留在系统，不分配。有人报名时每人份额 = floor(奖池 / 报名人数)。份额乘人数不会超过奖池，余下的分留在系统，记在 `remainder_fen`。份额不因本人当天有没有下单、下了多少、开了几轮而变化。份额大于剩余上限时仍发全额，超出的部分计入累计已领：下一轮还没开则暂停资格，下一轮已经开着则可以继续报名。

红包 100% 进入可提现账户，来源编码 `red_packet`，显示分类默认是「系统红包」。不拆积分或消费账户。创业专区不能退款，这里不做资格回滚。

需要管理员令牌：

- `GET /api/v1/admin/welfare/entry`
- `PUT /api/v1/admin/welfare/entry`，body：`{ "copy": "抢红包", "imageUrl": "https://cdn.example.com/welfare.png" }`。`imageUrl` 可省略或传空字符串，表示没有图片。文案最长 200，图片地址最长 512。多出来的字段会被拒绝，因此不能从这里改 K、C 或比例。
- `GET /api/v1/admin/welfare/signups?userId=&bizDate=&page=&pageSize=`
- `GET /api/v1/admin/welfare/participants?userId=&page=&pageSize=`

报名记录有 `id`、`userId`、`nickname`、`bizDate`、`signedAt`、`settled`、`payoutFen`。还没结算，或当天份额为 0，`payoutFen` 是 `null`。

参与记录有 `eligible`、`actualPayFen`、`openedRoundCount`、`claimCapFen`、`cumulativeClaimedFen`、`currentRoundNo`、`currentRoundClaimedFen`、`signedUpToday`。金额是十进制字符串。`currentRoundClaimedFen` 是本轮已领额度：已领金额按每轮 C 依次填充，正好领满时算在刚领满的那一轮，而不是下一轮的 0。若这个轮次号大于已开轮数，表示超额已经占着尚未开启的下一轮。这个边界展示还没有单独的官方句子，字段本身可以据此重算。

不传 `userId` 时，参与列表只翻已入座会员。传入 `userId` 时返回这个用户，包括还不是会员的人。

## 首页内容

管理端维护首页的轮播图、资讯和知识、滚动字幕。这些不是第 1.1 节的锁定运行配置。会员端只读当前可见内容，不要求会员资格；未登录仍返回 401「未登录」。停用账号沿用登录守卫，返回 401「登录已失效」。

需要用户令牌：

- `GET /api/v1/home/banners`。`data.items` 为当前 `status = on` 且已填写跳转页面的轮播图，按 `sortOrder` 升序、`id` 升序。每项有 `id`、`title`、`imageUrl`、`pagePath`、`sortOrder`。不分页。
- `GET /api/v1/home/tickers`。`data.items` 为当前 `status = on` 的滚动字幕，排序同上。每项有 `id`、`content`、`sortOrder`。不分页。
- `GET /api/v1/home/articles?kind=&page=&pageSize=`。只返回 `status = published` 的资讯。`kind` 可省略；传入时只能是 `article`（文章）、`news`（新闻）、`notice`（通知）。按 `publishedAt` 降序、`id` 降序。列表项有 `id`、`kind`、`title`、`summary`、`coverUrl`、`publishedAt`，不含正文。
- `GET /api/v1/home/articles/:id`。已发布内容的详情，比列表多 `body`。草稿、下架或不存在都是 404「内容不存在」。

需要管理员令牌。三种内容都支持列表、详情、创建、更新和下架。下架不删除行。

- 轮播图：`GET|POST /api/v1/admin/home/banners`，`GET|PUT /api/v1/admin/home/banners/:id`，`POST /api/v1/admin/home/banners/:id/status`
- 滚动字幕：把上面路径里的 `banners` 换成 `tickers`
- 资讯：换成 `articles`。列表还可按 `kind` 筛选

创建轮播图的 body：`{ "title", "imageUrl", "pagePath", "sortOrder", "status" }`。`sortOrder` 省略时为 0。`status` 省略时为 `draft`，也可传 `draft`、`on`、`off`。`imageUrl` 必须是 http 或 https，最长 512。`pagePath` 是小程序页面路径，最长 512，不能是 `http://` 或 `https://`。标题最长 128。更新 body 只带要改的字段，不改状态。状态下架传 `{ "status": "off" }`，也可以改回 `draft` 或 `on`。

创建滚动字幕的 body：`{ "content", "sortOrder", "status" }`。文案最长 255。状态与轮播图相同。

创建资讯的 body：`{ "kind", "title", "summary", "body", "coverUrl", "status" }`。`kind` 必填，取值同上。标题最长 200，摘要最长 500，正文最长 20000。`coverUrl` 可省略、传空或 `null`。`status` 省略时为 `draft`；传 `published` 时用业务时钟写入 `publishedAt`。更新不改状态，也不改 `publishedAt`。`POST .../status` 的 `status` 为 `draft`、`published` 或 `off`。从非发布改成 `published` 时，用当时的业务时钟重写 `publishedAt`。下架保留原来的 `publishedAt`。没有定时发布。

管理端列表带 `page`、`pageSize`，默认第 1 页、每页 20，最大 100。轮播图和字幕还可按 `status` 筛选。返回 `items`、`total`、`page`、`pageSize`。管理端详情比会员端多 `status`、`createdAt`、`updatedAt`；资讯详情始终含 `body`，未发布时 `publishedAt` 为 `null`。编号是十进制字符串。不存在时：轮播图 404「轮播图不存在」，字幕 404「滚动字幕不存在」，资讯 404「资讯不存在」。

## 钱包

每个用户有三个账户：`points`（积分）、`withdrawable`（可提现）、`consumption`（消费）。余额单位是分。同一用户不能在这三个账户之间互转。

需要用户令牌：

- `GET /api/v1/me/wallets`
- `GET /api/v1/me/wallets/:walletType/ledger?page=&pageSize=`，`walletType` 为 `points`、`withdrawable` 或 `consumption`
- `GET /api/v1/me/wallets/withdrawable/categories`
- `GET /api/v1/me/wallets/withdrawable/categories/ledger?displayName=&page=&pageSize=`

`GET /me/wallets` 的 `data` 为 `{ "points", "withdrawable", "consumption" }`。每个账户有 `balanceFen`、`frozenFen`、`availableFen`。可用额 = 余额 − 冻结。这三个数在 JSON 里是十进制字符串。还没有流水时三个账户都是 0。冻结包括待微信支付确认的占用，以及提现申请冻结的金额。

扣款和入账写 `wallet_ledger_entries`。冻结和释放不写流水，因为余额还没变。订单支付的 `bizType` 仍是 `order_payment`。可提现入账可以带 `sourceCode`，显示名不写在流水上。

可提现账户可以按显示名查看分类合计和流水。新库预置七个显示名，来源已经按官方对照分组：系统奖励（`cofounder`）、系统激励（`studio`）、平台分红（`operations`）、系统红包（`red_packet`）、销售激励（`startup_sales`、`startup_points`、`mall_sales`、`mall_points`）、幸运返还（`filing_settlement`，报单结算进入提现账户的部分）、业绩奖（`position_dividend`）。管理端把多个来源改成同一个显示名后，会员侧按显示名文本合成一个分类。不接受这十个来源以外的编码。运营团队的创业专区和商城分红都用来源 `operations`，因此都归在「平台分红」。两条流水的 `bizType` 分别是 `operations_startup` 和 `operations_mall`，分类流水里可以分开看。

需要管理员令牌：

- `GET /api/v1/admin/settings/withdrawal-display-names`
- `PUT /api/v1/admin/settings/withdrawal-display-names`，body：`{ "items": [{ "sourceCode": "mall_sales", "displayName": "销售奖" }] }`

## 消费账户划转

双方都必须已经是会员。付款人先按对方的用户 id 查询；id 不存在或对方不是会员时返回 400「对方不是会员」，不会进入确认。确认时返回对方的 `nickname`。划转时再提交金额和支付密码。密码错误则不动余额。

只从付款人消费账户的可用余额划到收款人的消费账户。没有手续费，也没有额外的单笔或每日上限。积分和可提现账户不能这样划。不能转给自己。不检查实名。

支付密码此前没有表。`POST /api/v1/me/payment-password` 首次设置，body：`{ "password": "..." }`。需求没有规定位数和字符集，当前接受 6 到 64 位且不含空白。已设置后再调返回 409。还没有重置接口。

需要用户令牌：

- `GET /api/v1/me/payment-password`，`data` 为 `{ "set": true }` 或 `{ "set": false }`
- `POST /api/v1/me/payment-password`
- `POST /api/v1/me/transfers/lookup`，body：`{ "payeeId": "2" }`
- `POST /api/v1/me/transfers`，body：`{ "payeeId": "2", "amountFen": "400", "paymentPassword": "123456" }`

划转成功时两边各写一条 `consumption_transfer` 流水，`bizId` 相同。非会员付款人返回 403「非会员不能划转」。

## 提现

只有会员可以提现。非会员即使可提现账户有余额也返回 403「非会员不能提现」。必须已经实名，否则 403「请先完成实名认证」。申请金额至少 100 元（10000 分）。

收款账户要事先保存，字段是开户名、开户银行、银行卡号、开户支行。一个用户当前一条。申请时把当时的四个字段抄到申请上，之后再改账户不影响这笔申请。

申请时冻结申请金额，不写扣款流水。驳回则解冻。财务线下打款。管理端把申请标成已打款或驳回。打款金额 = 申请金额 − 打款当时的 `WITHDRAWAL_FEE_FEN`。手续费在申请之后、打款之前变了，用打款当时的值。手续费高于申请金额时不能打款，冻结保持不变。每笔申请在驳回或打款时写一条结算记录。打款会从可提现账户扣掉全部申请金额，并在现金流水记一笔实际打出的金额。

有状态为待审核的商城退款时不能申请提现。

需要用户令牌：

- `GET|PUT /api/v1/me/bank-account`
- `POST /api/v1/me/withdrawals`，body：`{ "amountFen": "10000" }`
- `GET /api/v1/me/withdrawals?page=&pageSize=`
- `GET /api/v1/me/withdrawals/:id`

需要管理员令牌：

- `GET /api/v1/admin/withdrawals?status=&userId=&page=&pageSize=`
- `GET /api/v1/admin/withdrawals/:id`
- `POST /api/v1/admin/withdrawals/:id/reject`
- `POST /api/v1/admin/withdrawals/:id/payout`

状态是 `pending`、`rejected`、`paid`。

## 商城退款

只适用于会员商城里已支付或已发货的订单。创业专区返回 400「创业专区订单不能退款」。用户申请时不填写金额。返回里的 `freightFen` 和 `deductionHint` 只是提示运费等费用可以减扣，系统不会把运费自动算进减扣。

有状态为 `pending` 的提现时不能申请退款。提现驳回或打款、冻结清除之后可以申请。

审核人员只填 `refundFen` 或 `deductionFen` 里的一个。系统用订单应付（含该单运费）算出另一个：退款 + 减扣 = 应付。减扣先冲这单的微信支付部分，再冲这单支付时用掉的可提现部分，还剩的再从退回消费账户的金额里扣。微信实退加上消费账户入账等于退款金额。可提现部分里没有被减扣的余额退回消费账户，不退回可提现账户，也不再扣用户当前的可提现余额。已发放的奖励和商城分红池不回滚。订单状态保持已支付或已发货。

没有配齐微信商户资料时，微信部分记为 `sandbox`，不调用微信。已配齐时向微信申请退款，受理后记为 `accepted`，并写现金流出。微信拒收时退款申请仍是待审核，不动余额。

需要用户令牌：

- `POST /api/v1/orders/:id/refunds`
- `GET /api/v1/me/refunds?page=&pageSize=`
- `GET /api/v1/me/refunds/:id`

需要管理员令牌：

- `GET /api/v1/admin/refunds?status=&userId=&page=&pageSize=`
- `POST /api/v1/admin/refunds/:id/approve`，body 只含 `{ "refundFen": 9000 }` 或 `{ "deductionFen": 1000 }`
- `POST /api/v1/admin/refunds/:id/reject`

状态是 `pending`、`approved`、`rejected`。

## 订单

两个专区都要在下单时带一个已有收货地址。地址会抄进订单，之后改地址不影响已下的单。每个订单可以有多件商品，每件商品一个 SKU，只传数量。同一订单里商品不能重复。单次最多 50 种，每种数量 1 到 9999。

行商品金额 = 单价 × 数量。行运费 = 商品 `freightFen` × 数量。行 PV = 单价 PV × 数量。订单商品金额、运费、应付、PV 分别是各行之和。应付 = 商品金额 + 运费。PV 不是售价。创业专区单价 PV 按 0 记，订单 PV 为 0。

创业专区每件商品的单价是锁定单价 N。应付里的商品金额是 N 的整数倍。运费按商品上的 `freightFen` 另加，不另做地区运费。创业专区订单不能退款。会员商城订单可以申请退款，见上面的商城退款。

会员商城只有会员能下单。非会员返回 403，文案为「非会员不能购买会员商城」。

库存在支付成功时扣。下单时库存不够返回 409「库存不足」，不会生成订单。支付时如果库存已经被别人买完，同样返回「库存不足」，订单保持待支付，不扣款、不入座。

需要用户令牌：

- `GET /api/v1/orders?page=&pageSize=`
- `GET /api/v1/orders/:id`
- `POST /api/v1/orders`
- `POST /api/v1/orders/:id/pay`
- `POST /api/v1/orders/:id/cancel`
- `POST /api/v1/orders/:id/timeout`

下单 body：

```json
{
  "zone": "startup",
  "addressId": "1",
  "items": [{ "productId": "2", "quantity": 1 }]
}
```

`zone` 是 `startup` 或 `mall`。成功时 `data` 是订单。还没支付时四个来源金额都是 0，`status` 是 `pending_payment`。

订单字段：`id`、`orderNo`、`userId`、`zone`、`status`、`goodsTotalFen`、`freightFen`、`payAmountFen`、`pvFen`、`pointsFen`、`withdrawableFen`、`consumptionFen`、`wechatFen`、`shipping`（`contactName`、`contactPhone`、`province`、`city`、`district`、`detail`）、`courierName`、`trackingNumber`、`items`、`placedAt`、`paidAt`、`shippedAt`、`closedAt`。

行字段：`id`、`skuId`、`productName`、`skuName`、`unitPriceFen`、`unitPvFen`、`unitFreightFen`、`quantity`、`lineTotalFen`、`linePvFen`、`lineFreightFen`。

状态：`pending_payment`、`paid`、`shipped`、`closed`。

常见错误：

- 400「专区不正确」「地址不正确」「请选择商品」「商品重复」「数量不正确」「商品专区不一致」「商品未上架」「创业专区商品售价不正确」「商品 PV 不正确」「订单金额超出范围」「缺少邀请关系」
- 404「地址不存在」「商品不存在」「订单不存在」
- 409「库存不足」「订单不在待支付状态」「余额不足」

没入座的用户下创业专区订单时，必须已经通过 `POST /api/v1/me/inviter` 写过邀请上级。没有调用时不会默认挂到根账户，返回 400「缺少邀请关系」。已经入座的用户再次购买不再检查邀请关系，也不会改邀请上级。

### 支付顺序

`POST /api/v1/orders/:id/pay` 的 body 可空。`data` 是 `{ "order", "wechat" }`。账户够付时 `wechat` 为 `null`，订单直接变成 `paid`，不需要 `appId` 和 `openid`。否则 `wechat` 是预下单结果，订单仍是 `pending_payment`。

商户资料未配齐时，预下单是模拟结果，同样不需要这两个字段。已配齐时，客户端可以带 `appId` 和 `openid`；省略的字段用当前登录用户已有的 `wechat_mini` 身份补上。openid 是小程序登录时记下的身份标识，appId 是环境变量 `WECHAT_MINI_APP_ID`（登录向微信换 openid 用的就是这个小程序）。客户端若自行传入，必须和这个身份一致，否则返回 400「appId 或 openid 与当前微信身份不一致」。没有 `wechat_mini` 身份时（例如预览登录）返回 400「当前账号没有微信小程序身份，无法微信支付下单」，不会编造 openid。

来源顺序不能由调用方调整，也不能跳过。

创业专区：积分，然后可提现，然后微信。消费账户不参与。每个账户只能支付 N 的整数倍。可用额先取 `floor(可用余额 / N) × N`，再和剩余应付中同样对齐到 N 的部分取较小值。小于 N 的零头留在账户里。积分和可提现已经覆盖应付时，不发起微信支付。

会员商城：消费账户（可以付任意余数），然后可提现（也可以付任意余数），然后微信。积分不参与。消费账户，或消费加可提现，已经覆盖应付时，不发起微信支付。

需要微信支付时，先按上面的规则冻结积分、可提现或消费份额，再只为剩下的 `wechatFen` 下单。冻结期间余额不变，`frozenFen` 增加，可用额减少。微信成功之后才真正扣冻结的金额、扣库存，并把订单改成 `paid`。创业专区在同一次写入里入座。微信失败、用户取消或调用超时接口时，释放冻结，不扣余额，订单不完成。

取消和超时都是 `POST`，没有 body。两者都只作用于仍待支付的订单：释放冻结，把未完成的微信支付单标为失败，订单改为 `closed`。本阶段没有按固定时长自动关单。失败后的订单如果仍是 `pending_payment`，可以再次调用支付；会按当时的可用余额重新计算拆分。

支付成功、扣库存并完成入座之后，仍在同一事务里结算报单资格和奖励。创业专区生成报单子单，并在此人当天还没报过时立刻报其中一单；同时按应付金额发创业专区奖励。商城按订单 PV 发商城奖励。重复回调不会重复报单或重复入账。消息推送仍然没做。

### 发货

需要管理员令牌：

- `GET /api/v1/admin/orders?zone=&status=&userId=&page=&pageSize=`
- `GET /api/v1/admin/orders/:id`
- `POST /api/v1/admin/orders/:id/ship`，body：`{ "courierName": "顺丰", "trackingNumber": "SF100" }`

只有 `paid` 可以发货。成功后 `status` 为 `shipped`，并写上快递公司和运单号。重复发货返回 409「订单已发货」。未支付返回 409「只有已支付的订单可以发货」。快递公司或运单号为空返回 400「快递公司不正确」或「运单号不正确」。

## 入座

会员是已经有市场席位的用户。注册通过 `POST /api/v1/me/inviter` 写入邀请上级，不写席位。根账户启动时已经在两棵树的根上，不必购买。

创业专区订单支付成功，并且至少有一件商品时，如果该用户还没有席位，就从邀请人的席位往下找一个空位，写入席位，同时把用户行的 `member` 和 `seated` 改成 true。这两次更新在支付成功的同一个事务里。一个订单无论买几件，都只占一个席位。已经有席位的用户再买创业专区商品，不会新增席位，也不会改上级。

每个席位最多 3 个直接下级。下级谁在左边，只看入座时间，早的在左；时间相同则 id 小的在左。不另存左、中、右字段。

找空位时：

1. 用邀请关系找到邀请人的席位。邀请人还没有席位时，支付返回 400「缺少邀请关系」。
2. 邀请人自己还有空位时，按从左到右的第一个空位入座。
3. 这一层满了，就看下一层。每一组最多 3 个位子。优先坐空位更多的那一组；空位数一样时取最左边的一组；组内仍取最左边的空位。
4. 再满就用同样的规则继续往下，不设层数上限。新席位沿上级走，一定能走回这位邀请人。

接口文案不使用「市场树」或「节点」。

## 报单和全网公排

报单是内部词。会员没有报单接口，系统自动报。只有创业专区已支付、且单价等于当时锁定单价 N 的每一件数量，产生一条报单资格。运费不产生资格。每个用户每个 Asia/Shanghai 自然日最多完成一笔报单。

两条路径都会先确认此人当天还没报过：

1. 立即报。同一天的创业专区支付成功后，若当天还没报过，立刻报本次新子单里 id 最小的一笔，不等到凌晨。当天已经报过，则这些新子单留到以后的每日检查。
2. 每日检查。时刻是锁定配置 `FILING_DAILY_CHECK_TIME`，默认 `00:01`，时区 Asia/Shanghai。每个用户在未报过的子单里取下单时间最早的一笔，时间相同则取子单 id 较小的一笔。然后按同样的顺序逐笔报入公排。服务在当天这个时刻之后补跑；若已经跑过更晚的日期，时钟回拨不会把已完成的日期再跑一遍。进程第一次启动不会把历史每一天都补报，只从当天该跑的检查开始，之后漏掉的自然日会按顺序补上。

每完成一笔就进入全网公排，序号从 1 全局递增。序号为 5 的倍数时，立刻给序号 k（第 k 笔公排，不是按注册或邀请重排）入账，然后继续。积分账户增加当时的 N，可提现账户增加 `N × FILING_WITHDRAWAL_RATIO_BPS / 10000`（向下取整）。其他序号这一轮没有这笔返还。可提现入账来源是 `filing_settlement`，显示分类是幸运返还。

需要管理员令牌：

- `GET /api/v1/admin/filings?userId=&bizDate=&sequence=&page=&pageSize=`
- `GET /api/v1/admin/filings/:id`
- `GET /api/v1/admin/filing-settlements?userId=&page=&pageSize=`

报单字段：`id`、`filingNo`、`userId`、`nickname`、`orderId`、`subOrderId`、`sequence`、`bizDate`、`status`（`filed` 或 `settled`）、`amountFen`、`filedAt`、`settledAt`、`settlement`、`triggeredSettlement`。`settlement` 是这一笔作为第 k 单领到的幸运返还。`triggeredSettlement` 只在序号为 5 的倍数时出现，表示这笔完成时发给序号 k 的返还。返还字段有 `triggerSequence`、`beneficiaryFilingId`、`beneficiaryUserId`、`pointsFen`、`withdrawableFen`、`unitPriceFen`、`withdrawalRatioBps`、`settledAt`。

## 创业专区奖励和商城奖励

两笔都在支付成功时计算，和这单有没有报过无关。金额用整数分，比例向下取整。三个账户拆分后的余数加给比例最大的一项（相同则先可提现，再积分，再消费），三项之和等于原奖励额。为 0 的账户不写流水。

创业专区按商品金额计算，也就是 N × 件数，多件合计，不含运费。拆分用创业奖配置：

- 销售奖只给邀请关系上的直接邀请人，金额 = 应付 × R。来源 `startup_sales`。
- 见点奖给市场上的上级，不含购买人本人。每一层单独拿应付 × P。第 1 到 4 层没有额外条件。第 5 到 8 层要求收款人已有至少 3 笔创业子单、合计至少 3N，并且邀请关系下至少 3 名已入座的直接会员。第 9 到 12 层把 3 换成 5。某一层不够就跳过，继续往上。第 13 层及以上不发。来源 `startup_points`。

商城按订单 PV 计算（`pvFen`，1 PV = 1 元 = 100 分），只走邀请关系，不走市场，拆分用商城配置，没有额外层门槛：

- 第 1 层（直接邀请人）拿 PV × S，来源 `mall_sales`，不再拿见点奖。
- 第 2 到 15 层各自拿 PV × Q，来源 `mall_points`。邀请链结束就停。第 16 层及以上不发。

需要管理员令牌：

- `GET /api/v1/admin/awards?userId=&orderId=&rewardType=&layer=&page=&pageSize=`

`rewardType` 只能是 `startup_sales`、`startup_points`、`mall_sales`、`mall_points`。销售奖的 `layer` 记为 1，表示直接邀请人。见点奖的 `layer` 是往上数的层。返回 `id`、`userId`、`nickname`、`rewardType`、`orderId`、`layer`、`amountFen`、`occurredAt`，以及 `wallets`（`walletType`、`amountFen`、`sourceCode`）。可提现那一条才有 `sourceCode`。

## 月度职位和次月业绩奖

职位按 Asia/Shanghai 自然月计算，不是永久头衔。一个市场是一名直接下级加上该下级下面的所有人，最多 3 个。资格不用邀请关系。

营销经理：至少 2 个市场在该月的创业专区已付总额达到当月 T。更高职位：至少 2 个市场里，各自至少有 2 名该月达到上一档的会员，人可以在该市场的任意深度。

次月分配上月全平台商城 PV。示例池是营销经理 8%、高级经理 6%、营销总监 5%、高级总监 4%、首席 3%，实际比例读 `POSITION_DIVIDEND_POOL_BPS`。8% 这一档不含同时达到更高职位的人。更高档包含，即使此人还达到更上面的职位。池子金额 = 上月商城 PV × 该档万分比，再在合格会员之间整除。除不尽的余数留在系统。没有合格会员的档位也留在系统，不并入其他档，也不留到下月。入账来源 `position_dividend`，显示分类业绩奖，拆分用商城配置。

发放日在业绩月的次月，默认 15 日。只能在本期自动发放之前，改到一个还没到来、并且仍在该次月里的日期。发放日前可以看上月报表，也可以把指定会员移出自动发放。不能整期取消。被移出的人，原来算好的份额不重新分给其他人。只有被移出的人可以手工改额发放，必须填写备注，并同时留下原额和实发额，拆分仍用商城配置。自动和手工记录在同一张表里查询。

退款不减少已结束月份的商城 PV，创业专区订单也不能退款，所以月份结束后重算结果不变。

需要管理员令牌：

- `GET /api/v1/admin/position-dividends?month=YYYY-MM`，不传 `month` 时是上一个已结束的自然月。当月还没结束不能查。
- `GET /api/v1/admin/position-dividends/qualifications/:userId?month=`
- `PUT /api/v1/admin/position-dividends/:month/payout-date`，body：`{ "payoutDate": "2026-11-20" }`
- `POST /api/v1/admin/position-dividends/:month/exclusions`，body：`{ "userId": "2" }`
- `POST /api/v1/admin/position-dividends/:month/manual-payments`，body：`{ "userId": "2", "positionCode": "marketing_manager", "actualAmountFen": "1000", "remark": "线下调整" }`
- `GET /api/v1/admin/position-dividends/:month/records?page=&pageSize=`

报表 `data` 含 `performanceMonth`、`payoutMonth`、`payoutDate`、`status`（`open` 或 `paid`）、`thresholdFen`、`mallPvFen`、`pools`。每个池有 `positionCode`、`positionName`、`poolBps`、`exclusive`、`poolFen`、`eligibleCount`、`shareFen`、`members`。成员有 `userId`、`nickname`、`removed`、`originalAmountFen`、`payment`。`payment` 为 `null`，或 `{ "mode": "auto" | "manual", "actualAmountFen", "remark", "paidAt" }`。

资格接口的 `ranks` 每一档有 `qualified` 和 `inPool`。`qualified` 表示达到该档条件。营销经理的 `inPool` 在同时达到更高档时为 false。`markets` 是直接市场和该月业绩。

发放记录有 `id`、`userId`、`positionCode`、`positionName`、`mode`、`originalAmountFen`、`actualAmountFen`、`remark`、`paidAt`。

业绩月尚未结束、发放日不在次月、或发放日不是未来日期，返回 400。本期已自动发放后再改日期返回 409。手工发给没被移出的会员返回 400。同一职位重复手工发放返回 409。

## 创业团队

需要用户令牌：

- `GET /api/v1/me/team`

`data` 为 `{ "marketCount", "totalPerformanceFen", "markets" }`。没有直接市场时 `marketCount` 为 0，`totalPerformanceFen` 为 `"0"`，`markets` 为 `[]`。

每个市场有 `name`（直接下级的昵称，空昵称显示「会员」）、`monthPerformanceFen`、`recent7DaysPerformanceFen`、`todayPerformanceFen`。顺序是入座时间早的在前，相同则编号小的在前。

业绩口径：该下级及其下面所有人的创业专区已支付订单应付金额之和，含运费，单位分。不含查看者自己的订单。本月、今天按 Asia/Shanghai 的自然月和自然日，截止到下一天或下一个月的起点。近 7 日是含今天在内的 7 个自然日，不是滚动 168 小时。官方文档没有另定口径。接口字段和文案不使用「市场树」或「节点」。

## 管理端关系和钱包

小程序没有这些入口。管理端可以查看。这里可以使用「市场树」。

需要管理员令牌：

- `GET /api/v1/admin/users/:id/invite`
- `GET /api/v1/admin/users/:id/invite/ancestors`
- `GET /api/v1/admin/users/:id/invite/descendants?depth=`
- `GET /api/v1/admin/users/:id/market-tree`
- `GET /api/v1/admin/users/:id/wallets`
- `GET /api/v1/admin/users/:id/wallet-holds?status=&page=&pageSize=`
- `GET /api/v1/admin/users/:id/wallets/:walletType/ledger?page=&pageSize=`
- `GET /api/v1/admin/transfers?payerId=&payeeId=&page=&pageSize=`

邀请接口的 `data` 含 `user`、`inviter`、`directInvitees`。人和邀请人有 `userId`、`nickname`、`inviteCode`、`member`。直接邀请人另有 `joinedAt`。`ancestors.items` 从直接上级走到根。`descendants` 的 `depth` 默认 5，最大 20，返回 `{ "depth", "items" }`，每一项还有 `parentUserId` 和相对层数。

市场树接口含 `seated`、`depth`、`placedAt`、`parent`、`markets`。每个市场有 `userId`、`nickname`、`placedAt`、`memberCount`、`members`。成员含该市场本人和下面的人，字段是 `userId`、`nickname`、`depth`、`placedAt`。还没入座时 `seated` 为 false，`markets` 为空。

钱包余额形状和会员自己的 `GET /me/wallets` 相同。冻结记录有 `id`、`orderId`、`walletType`、`amountFen`、`status`、`createdAt`、`updatedAt`。流水形状和会员流水相同。划转记录有 `id`、`payerUserId`、`payerNickname`、`payeeUserId`、`payeeNickname`、`amountFen`、`createdAt`。

用户不存在返回 404「用户不存在」。`walletType` 不是 `points`、`withdrawable`、`consumption` 时返回 400。

## 联合创始人

同一会员还可以同时是工作室，也可以是当时唯一的运营团队。指定或取消联合创始人不改那两个身份。运营团队全网同时只有一人，规则见运营团队一节。

创业专区基数是订单 `goods_total_fen`（N × 件数，含钱包支付的货款，不含运费，不用 `wechat_fen`）。商城基数是订单 `pv_fen`。比例分别是 `cofounderStartupDividendRatioBps` 和 `cofounderMallDividendRatioBps`。金额向下取整。100% 进入可提现账户，来源 `cofounder`，新库显示名是「系统奖励」。购买人自己如果当时在籍，也参与均分。

均分用整数除法。每人份额 × 人数不会超过本次金额，余数留在系统，不结转到下一笔。需求没有写余数，这是待确认的实现选择。没人在籍时，这笔不发给任何人，也留在系统。

四种分配方式互斥，默认是即时分配。这个默认需求没有写明，待确认。

1. `immediate`：每笔合格订单当时均分，不进累计池。
2. `periodic`：订单先进入同一个池子。到管理端配置的上海钟点，把池子全部分完再清零。周期是 `daily`、`weekly`、`monthly` 或 `interval`。每周用 `weekday`（周一 1，周日 7）。每月用 `monthDay`；该月没有这一天时用最后一天，待确认。`interval` 从 `anchorDate` 起每 `intervalDays` 天一次。
3. `pool_total`：池子达到 `poolThresholdFen` 时，把当时的全部金额分完。从 19999 到 20001 会分 20001，不是只分 20000。
4. `per_person`：每来一笔后，用池子除以当时在籍人数的整数份额和 `perPersonThresholdFen` 比较。达到后把整个池子分完。

改分配方式，或在定期分配下改周期、钟点、星期、月日、间隔或锚点时，先处理池子里已有的钱：有在籍的人就立刻分完并清零；没有人就把钱留在系统再清零。原来是即时分配且池子本来就是空的，直接切换。切到定期分配时，已经过去的那一档记成处理过，避免刚切换就再发一次。只把池子总额或人均门槛改低、且已经达到新门槛时，也会按新规则分掉当前池子。这是待确认的实现选择。

取消不写退款，也不动钱包。取消后用户端「成为联合创始人」按钮关掉，要管理员再打开。名额没满时按钮也不会因为有人退出而自己打开。名额满了用户不能支付开通，管理员仍可指定，在籍人数可以超过上限。取消后再开通会新写一行在籍记录，待确认。

开通费只走微信支付。会员点开通后复用 `POST /api/v1/payments/wechat/prepay` 同一套预下单、回调和 `POST /api/v1/payments/wechat/sandbox/succeed`。商户资料没配齐时返回沙箱预支付，不会直接入籍。已配齐但没有 `WECHAT_PAY_NOTIFY_URL` 时拒绝下单。成功后立刻在籍，并写一条现金流入 `cofounder_activation`。不生成商品订单。积分、可提现、消费账户不能抵开通费。

需要会员令牌：

- `GET /api/v1/me/cofounder`：入口文案和图片、介绍页标题正文和图片、`enrolled`、`enrolledAt`、`source`、`button`（`available`、`reason`）、`seatCap`、`enrolledCount`、`activationAmountFen`、未完成的 `pendingActivation`。`reason` 为 `already_enrolled`、`not_member`、`cap_full`、`closed`、`amount_unset`、`open`。已在籍时客户端可以显示「你已是联合创始人」。
- `POST /api/v1/me/cofounder/activations`：发起开通。成功时 `data` 是微信支付预下单，另加 `activationId`。`purpose` 为 `cofounder_activation`，`orderId` 为 null。随后用返回的 `payNo` 走现有沙箱成功或微信回调。

需要管理员令牌：

- `GET /api/v1/admin/cofounder/settings`、`PUT /api/v1/admin/cofounder/settings`
- `GET /api/v1/admin/cofounder/content`、`PUT /api/v1/admin/cofounder/content`
- `GET /api/v1/admin/cofounders?status=&page=&pageSize=`
- `POST /api/v1/admin/cofounders`，body：`{ "userId": "1" }`，指定在籍，可以超过名额
- `GET /api/v1/admin/cofounders/:userId/cancellation`：按奖励类型的累计入账、联合创始人分红、当前可提现余额、已提现笔数和明细。不执行退款
- `POST /api/v1/admin/cofounders/:userId/cancel`：取消身份。在籍人数减 1，并关闭用户端按钮

设置 body：`seatCap`、`userButtonOpen`、`activationAmountFen`、`payoutMode`（`immediate` / `periodic` / `pool_total` / `per_person`）、`schedule`（`cycle`、`time`、`weekday`、`monthDay`、`intervalDays`、`anchorDate`）、`poolThresholdFen`、`perPersonThresholdFen`。金额是十进制字符串。返回里另有 `enrolledCount`、`poolFen` 和只读的 `lockedRates`。多写分红比例会被拒绝。

内容 body：`entryCopy`、`entryImageUrls`、`introTitle`、`introBody`、`introImageUrls`。

新库默认：名额 100、按钮关闭、开通金额 0、即时分配、每天 00:00。名额示例 100 来自需求。按钮默认关闭、金额默认 0、分配方式默认即时、钟点默认 00:00，需求没有写死，待确认。开通金额为 0 时按钮原因是 `amount_unset`，不能下单。

## 工作室

工作室是第二种身份。只有管理员可以指定和取消。没有会员自助开通，也没有微信支付预下单。被指定的人必须已经是会员。没有人数上限。同一会员可以同时是联合创始人，也可以是当时唯一的运营团队。指定或取消工作室不会取消另外两个身份。

补贴在订单支付成功时立刻入账。不进全网池，也不在工作室之间拆分。一名工作室只拿自己这棵树上的补贴。同一订单如果同时落在多名工作室的树里，例如上级和购买人自己都是工作室，每人按自己的树各记一笔全额，互不替代，也不减少联合创始人已经计提的分红。

1. 创业专区看市场树，包含工作室本人和全部下级。基数是订单 `goods_total_fen`（N × 件数，含钱包支付的货款，不含运费，不用 `wechat_fen`）。比例是 `STUDIO_STARTUP_SUBSIDY_RATIO_BPS`。
2. 会员商城看邀请树，包含工作室本人和全部下级。基数是订单 `pv_fen`。比例是 `STUDIO_MALL_SUBSIDY_RATIO_BPS`。

两条比例只在进程启动时读入，官方示例都是 200（2%）。管理端不能改，也不能从任何管理端设置接口写入。金额按万分比向下取整。算出来是 0 时不写流水。100% 进入该工作室的可提现账户，来源编码 `studio`，奖励类型也是 `studio`。内部始终按工作室补贴入账。可提现分类默认是「系统激励」，沿用已有的分类改名接口，这里不另做七个分类的改名。这是账户入账，不写现金流水，也不增加运营总览首屏指标。

对外名称默认「补贴」，存在 `admin_settings` 的 `studio_external_name`。管理员可以改这个名称。改名称不会改可提现分类，也不会改已经入账的来源编码。

取消只改身份。不退款，不动钱包。取消后不再发新的补贴，已经入账的保留。取消后可以再次指定，另写一行。

同一订单仍会按已有规则计提联合创始人分红。重复支付成功不会把同一笔补贴再记一次。

需要管理员令牌：

- `GET /api/v1/admin/studios?status=&page=&pageSize=`。`status` 为 `active` 或 `cancelled`。每项有 `id`、`userId`、`nickname`、`member`、`status`、`enrolledAt`、`cancelledAt`。
- `POST /api/v1/admin/studios`，body：`{ "userId": "1" }`。非会员返回 403「非会员不能被指定为工作室」。用户不存在返回 404「会员不存在」。已经在籍返回 409「该会员已是工作室」。
- `POST /api/v1/admin/studios/:userId/cancel`。不是在籍工作室返回 404「该会员不是工作室」。
- `GET /api/v1/admin/studio/settings`，`data` 为 `{ "externalName": "补贴" }`。
- `PUT /api/v1/admin/studio/settings`，body：`{ "externalName": "补贴" }`。名称去掉首尾空白后为 1 到 64 个字符。多出来的字段会被拒绝，因此不能从这里改两条补贴比例或 `00:01` 报单钟点。

没有 `POST /api/v1/me/studio` 之类的开通或预支付接口。

## 运营团队

运营团队是第三种身份，也称运营负责人。全网同时只有一名会员持有。分红只发给这个人，不与其他人拆分。只有管理员可以指定、改派和取消。没有会员自助开通，也没有微信支付预下单。被指定的人必须已经是会员。同一会员可以同时是联合创始人和工作室；指定运营团队不会取消那两个身份。

指定另一个会员就是改派：上一任立刻不再领取之后的分红，已经入账的留在原账户，不退款，也不把余额转给新持有人。取消之后没有持有人。支付成功时如果没有人在籍，这笔不发给任何人，也不进入池子。之后才指定的人不会补领这笔。

分红在订单支付成功时立刻入账。不看市场树，也不看邀请树。全部已支付的创业专区订单和全部已支付的商城订单都计提。同一订单仍会按已有规则计提联合创始人分红和工作室补贴。

1. 创业专区基数是订单 `goods_total_fen`（N × 件数，含钱包支付的货款，不含运费，不用 `wechat_fen`）。比例是 `OPS_TEAM_STARTUP_DIVIDEND_RATIO_BPS`。官方示例 500（5%）。
2. 会员商城基数是订单 `pv_fen`（1 PV = 1 元）。比例是 `OPS_TEAM_MALL_DIVIDEND_RATIO_BPS`。官方示例 700（7%）。

两条比例只在进程启动时读入。管理端不能改，也不能从任何管理端设置接口写入。原先的单条 `OPERATIONS_TEAM_DIVIDEND_RATIO_BPS` 或 `OPS_TEAM_DIVIDEND_RATIO_BPS` 不再读取。金额按万分比向下取整。算出来是 0 时不写流水。100% 进入该会员的可提现账户，来源编码 `operations`，奖励类型也是 `operations`。创业专区流水的 `bizType` 是 `operations_startup`，商城流水的 `bizType` 是 `operations_mall`。可提现分类默认是「平台分红」。这是账户入账，不写现金流水，也不增加运营总览首屏指标。

会员在自己的可提现账户查看当前合计和每一笔。`GET /api/v1/me/wallets/withdrawable/categories` 里「平台分红」是合计。`GET /api/v1/me/wallets/withdrawable/categories/ledger?displayName=平台分红` 按 `bizType` 区分两条。登录资料和「我的」不返回这个身份。

取消只改身份。不退款，不动钱包。取消后不再发新的分红，已经入账的保留。

重复支付成功不会把同一笔分红再记一次。

需要管理员令牌：

- `GET /api/v1/admin/ops-team`。`data` 为 `{ "holder": null }`，或 `holder` 含 `id`、`userId`、`nickname`、`member`、`status`、`enrolledAt`、`cancelledAt`。有人在籍时 `status` 为 `active`，`cancelledAt` 为 null。
- `POST /api/v1/admin/ops-team`，body：`{ "userId": "1" }`。没人在籍时指定这名会员。已经有别人在籍时，同一请求里取消上一任并指定新人。非会员返回 403「非会员不能被指定为运营团队」。用户不存在返回 404「会员不存在」。已经是当前持有人返回 409「该会员已是运营团队」。
- `POST /api/v1/admin/ops-team/cancel`。没有请求体。当前没有运营团队返回 404「当前没有运营团队」。

没有 `POST /api/v1/me/ops-team` 之类的开通或预支付接口，也没有运营团队设置接口。

## 定时任务

BullMQ 队列 `due-jobs` 大约每 30 秒触发一次，进程启动时也会跑一次。任务只调用 `ClockService.now()` 决定有没有到点，不把操作系统时间当成业务日。每日报单检查、职位分红、红包结算和联合创始人定期分配都可以重复执行：已经报过的自然日、已经入账的业务号、已经处理过的发放档期不会再记一笔。联合创始人的钟点来自管理端配置，不是锁定的 `00:01`。

## 微信支付

商户号、API 证书和 APIv3 密钥存在 `admin_settings`，由管理员接口写入，不写进代码或仓库。证书字段要同时贴上 `apiclient_cert.pem` 和 `apiclient_key.pem`。读取接口会打码 APIv3 密钥，并且不返回证书正文。三项都合法之后视为已配置。

- `GET /api/v1/admin/settings/wechat-pay`
- `PUT /api/v1/admin/settings/wechat-pay`，body 可只带要改的字段：`merchantId`、`apiCertificate`、`apiV3Key`
- `DELETE /api/v1/admin/settings/wechat-pay` 清空这三项，之后重新允许模拟成功

正常结账走 `POST /api/v1/orders/:id/pay`。它在需要微信时才调用预下单。预下单金额是订单上的 `wechatFen`，不是整个应付。还没算过支付拆分时，直接预下单返回 400「订单尚未确定支付拆分」。

- `POST /api/v1/payments/wechat/prepay`，body：`{ "orderId": "1", "appId": "wx...", "openid": "..." }`
- 未配齐商户资料时返回 `mode: "sandbox"`，不调用微信。`POST /api/v1/payments/wechat/sandbox/succeed`，body：`{ "payNo": "..." }`，把该支付单标为成功。订单若仍待支付，就扣掉已冻结的账户份额、扣库存并完成订单。`POST /api/v1/payments/wechat/sandbox/fail` 用同样的 body 模拟失败，释放冻结，不完成订单。
- 已配齐时还需要环境变量 `WECHAT_PAY_NOTIFY_URL`。`POST /api/v1/orders/:id/pay` 可以省略 `appId` 和 `openid`，省略时使用当前会话的 `wechat_mini` 身份；没有该身份则不能正式下单。直接调用 `POST /api/v1/payments/wechat/prepay` 时仍要在 body 里带上 `appId` 和 `openid`。接口向微信 JSAPI 下单，返回 `mode: "live"` 和小程序 `requestPayment` 需要的签名字段。
- 回调是 `POST /api/v1/payments/wechat/notify`。验签和解密使用已保存的商户资料和微信支付平台证书。成功且金额、商户号一致时，支付单变为 `success`，并完成仍待支付的订单。`PAYERROR` / `CLOSED` / `REVOKED` 把仍在待支付的支付单标为 `failed`，并释放冻结。`success` 之后不再改回失败；若之前已是 `failed` 又收到 `SUCCESS`，改为成功。订单已经关闭时，这笔成功不会把订单改成已支付。重复通知不会重复扣款或重复入座。
- 商户资料已配齐时，模拟成功和模拟失败都返回 403。

密钥和证书只来自管理员已保存的商户资料，不写进代码。

回调响应是微信要求的 `{ "code": "SUCCESS" | "FAIL", "message": "..." }`，不套本系统的 `{ code, message, data }`。

## 数据库

Schema 在 `prisma/schema/`，初始迁移在 `prisma/schema/migrations/`。没有强制外键。逻辑关系和基数见 [docs/er.md](docs/er.md)，同目录有 SVG / PNG。

表按域拆开：用户与身份、地址、管理员、商品与库存、订单与支付、钱包流水、Banner / 文章 / 滚动条、邀请树、市场树、报单、奖励流水、职位、红包、联合创始人、工作室、运营团队、管理员配置。

状态字段是字符串，由应用写入，数据库不设业务默认值。用户状态是 `active` / `disabled`，商品状态是 `draft` / `on` / `off`，实名状态是 `verified`。管理员状态是 `active`，订单状态使用 `pending_payment` / `paid` / `shipped` / `closed`，微信支付状态使用 `pending` / `success` / `failed`，钱包冻结状态使用 `held` / `captured` / `released`。账户类型是 `points` / `withdrawable` / `consumption`。首页轮播图和滚动字幕是 `draft` / `on` / `off`，资讯是 `draft` / `published` / `off`，资讯类型是 `article` / `news` / `notice`。其余注释里的状态仍是预留。
