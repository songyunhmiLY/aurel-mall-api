# 数据模型（逻辑关系）

图中的连线是**逻辑关联**和基数，不是数据库外键。表之间只保存对方的 id，并建立普通索引或唯一索引。完整性以后由服务层保证，Prisma 模型里没有 `@relation`。

金额字段单位是**分**。业务时间由应用通过 `ClockService` 写入，列上没有 `CURRENT_TIMESTAMP` 默认值。

小程序登录键是 `user_identities` 里 `provider = wechat_mini` 的 openid。手机号不是登录键。`wechat_oa`、`wechat_web`、`sms_phone` 只预留。`union_id` 只留存，不参与合并。

渲染好的图：

| 域                   | Mermaid 源                                    | SVG                           | PNG                           |
| -------------------- | --------------------------------------------- | ----------------------------- | ----------------------------- |
| 身份、地址、管理员   | [01-identity.mmd](er/01-identity.mmd)         | [SVG](er/01-identity.svg)     | [PNG](er/01-identity.png)     |
| 商品、SKU、库存      | [02-catalog.mmd](er/02-catalog.mmd)           | [SVG](er/02-catalog.svg)      | [PNG](er/02-catalog.png)      |
| 订单与支付           | [03-orders.mmd](er/03-orders.mmd)             | [SVG](er/03-orders.svg)       | [PNG](er/03-orders.png)       |
| 钱包流水             | [04-wallet.mmd](er/04-wallet.mmd)             | [SVG](er/04-wallet.svg)       | [PNG](er/04-wallet.png)       |
| 内容                 | [05-cms.mmd](er/05-cms.mmd)                   | [SVG](er/05-cms.svg)          | [PNG](er/05-cms.png)          |
| 树、报单、奖励、职位 | [06-organization.mmd](er/06-organization.mmd) | [SVG](er/06-organization.svg) | [PNG](er/06-organization.png) |
| 红包                 | [07-red-packet.mmd](er/07-red-packet.mmd)     | [SVG](er/07-red-packet.svg)   | [PNG](er/07-red-packet.png)   |

## 1. 身份、地址、管理员

`admin_settings` 只放管理员可改的配置（营销经理市场门槛 T，以及微信支付商户号、API 证书、APIv3 密钥）。锁定配置不进这张表。证书放在 `TEXT` 字段里。

`users.phone` 是微信手机号组件绑定的号码，可空、不唯一。`users.invite_code` 根账户是 `ROOT`。其他用户在第一次入座前为空，入座时写入唯一邀请码。`users.member` 和 `users.seated` 表示已经有市场席位，入座时一起写成 true。`user_kyc` 保存姓名、身份证号和手机号；格式通过后 `status = verified`。

```mermaid
erDiagram
  users ||--o{ user_identities : "user_id"
  users ||--o| user_kyc : "user_id"
  users ||--o{ user_addresses : "user_id"
  admin_users |o--o{ admin_settings : "updated_by_admin_id"

  users {
    bigint id PK
    varchar status
    varchar nickname
    varchar phone
    varchar invite_code UK
    boolean member
    boolean seated
    datetime created_at
    datetime updated_at
  }
  user_identities {
    bigint id PK
    bigint user_id
    varchar provider
    varchar identifier UK
    varchar union_id
  }
  user_kyc {
    bigint id PK
    bigint user_id UK
    varchar real_name
    char id_number
    varchar mobile
    varchar status
  }
  user_addresses {
    bigint id PK
    bigint user_id
    varchar contact_name
    boolean is_default
  }
  admin_users {
    bigint id PK
    varchar username UK
    varchar password_hash
    varchar status
  }
  admin_settings {
    bigint id PK
    varchar setting_key UK
    text setting_value
    bigint updated_by_admin_id
  }
```

## 2. 商品、SKU、库存

`products.zone` 是 `mall`（会员商城）或 `startup`（创业专区）。每个商品一个 SKU。价格和运费是分。商城 `pv_fen` 也是分，100 = 1 PV = 1 元；创业专区保持 null。`mall_categories` 只给会员商城用。

```mermaid
erDiagram
  mall_categories ||--o{ products : "category_id"
  products ||--o{ product_images : "product_id"
  products ||--o{ product_skus : "product_id"
  product_skus ||--o| sku_stocks : "sku_id"

  mall_categories {
    bigint id PK
    varchar name
    int sort_order
  }
  products {
    bigint id PK
    varchar zone
    varchar name
    text body
    int freight_fen
    bigint category_id
    varchar status
  }
  product_images {
    bigint id PK
    bigint product_id
    varchar url
    int sort_order
  }
  product_skus {
    bigint id PK
    bigint product_id
    varchar sku_code UK
    int price_fen
    int pv_fen
    varchar status
  }
  sku_stocks {
    bigint id PK
    bigint sku_id UK
    int quantity
    datetime updated_at
  }
```

## 3. 订单与支付

`payments.channel = wechat` 时走微信支付下单和回调。状态是 `pending` / `success` / `failed`。金额是订单拆分后的 `wechat_fen`，不是整个应付。`placed_at` / `paid_at` / `shipped_at` / `succeeded_at` 都由时钟写入。积分、可提现、消费的占用和扣款记在订单列和钱包表上。

```mermaid
erDiagram
  users ||--o{ orders : "user_id"
  orders ||--o{ order_items : "order_id"
  product_skus ||--o{ order_items : "sku_id"
  orders ||--o{ payments : "order_id"

  orders {
    bigint id PK
    varchar order_no UK
    bigint user_id
    varchar zone
    varchar status
    int pay_amount_fen
    int freight_fen
    int pv_fen
    int points_fen
    int withdrawable_fen
    int consumption_fen
    int wechat_fen
    varchar contact_name
    varchar tracking_no
    datetime placed_at
    datetime paid_at
    datetime shipped_at
  }
  order_items {
    bigint id PK
    bigint order_id
    bigint sku_id
    int unit_price_fen
    int quantity
    int line_total_fen
  }
  payments {
    bigint id PK
    bigint order_id
    varchar pay_no UK
    varchar channel
    int amount_fen
    varchar status
    varchar channel_trade_no UK
    varchar prepay_id
    varchar active_slot UK
    datetime succeeded_at
  }
```

## 4. 钱包流水

账户类型是 `points`（积分）、`withdrawable`（可提现）和 `consumption`（消费）。同一用户每种类型一行。`frozen_fen` 是待微信支付确认的占用。`wallet_holds.status` 是 `held` / `captured` / `released`。

```mermaid
erDiagram
  users ||--o{ wallet_accounts : "user_id"
  users ||--o{ wallet_holds : "user_id"
  wallet_accounts ||--o{ wallet_ledger_entries : "account_id"

  wallet_accounts {
    bigint id PK
    bigint user_id
    varchar wallet_type
    bigint balance_fen
    bigint frozen_fen
  }
  wallet_holds {
    bigint id PK
    bigint order_id
    varchar wallet_type
    bigint amount_fen
    varchar status
  }
  wallet_ledger_entries {
    bigint id PK
    bigint account_id
    bigint user_id
    varchar direction
    bigint amount_fen
    bigint balance_after_fen
    varchar biz_type
    varchar biz_id
    datetime occurred_at
  }
```

## 5. 内容

Banner、文章、滚动条彼此没有关联。

```mermaid
erDiagram
  banners {
    bigint id PK
    varchar title
    varchar image_url
    varchar link_url
    int sort_order
    varchar status
  }
  articles {
    bigint id PK
    varchar title
    text body
    varchar status
    datetime published_at
  }
  tickers {
    bigint id PK
    varchar content
    int sort_order
    varchar status
  }
```

## 6. 邀请树、市场树、报单、奖励、职位

两棵树分开存。启动时只为官方根账户各写一行：`parent_user_id` 为空，`depth` 为 0。其他用户注册后只进邀请树；创业专区支付成功后，从邀请人的席位按每层最多 3 个下级入座。有市场席位才是会员，并写回 `users.member` / `users.seated`。职位分红**份额**不在 `positions` 表里，而在环境变量 `POSITION_DIVIDEND_SHARE_TIERS`，用 `positions.code` 做逻辑对应。

```mermaid
erDiagram
  users ||--o| invite_tree_nodes : "user_id"
  users ||--o| market_tree_nodes : "user_id"
  invite_tree_nodes |o--o{ invite_tree_nodes : "parent_user_id"
  market_tree_nodes |o--o{ market_tree_nodes : "parent_user_id"
  users ||--o{ filings : "user_id"
  orders |o--o{ filings : "order_id"
  users ||--o{ reward_ledger_entries : "user_id"
  users ||--o{ user_positions : "user_id"
  positions ||--o{ user_positions : "position_id"

  invite_tree_nodes {
    bigint id PK
    bigint user_id UK
    bigint parent_user_id
    int depth
    varchar path
    datetime joined_at
  }
  market_tree_nodes {
    bigint id PK
    bigint user_id UK
    bigint parent_user_id
    int depth
    varchar path
    datetime placed_at
  }
  filings {
    bigint id PK
    varchar filing_no UK
    bigint user_id
    bigint order_id
    varchar status
    int amount_fen
    datetime filed_at
  }
  reward_ledger_entries {
    bigint id PK
    bigint user_id
    varchar reward_type
    bigint amount_fen
    varchar status
    datetime occurred_at
  }
  positions {
    bigint id PK
    varchar code UK
    varchar name
    int rank_level
  }
  user_positions {
    bigint id PK
    bigint user_id
    bigint position_id
    varchar status
    datetime granted_at
  }
```

## 7. 红包

日计提按 Asia/Shanghai 的日历日一行。开轮时把当时的门槛 K、单轮上限 C 抄进 `red_packet_rounds`。是否每人每轮只能领一次还没定，所以 `round_id + user_id` 只建了普通索引。

```mermaid
erDiagram
  red_packet_rounds ||--o{ red_packet_claims : "round_id"
  users ||--o{ red_packet_claims : "user_id"

  red_packet_daily_accruals {
    bigint id PK
    char biz_date UK
    bigint startup_sales_fen
    bigint accrual_fen
    datetime accrued_at
  }
  red_packet_rounds {
    bigint id PK
    int round_no UK
    varchar status
    int pay_threshold_fen
    int claim_cap_fen
    datetime opened_at
  }
  red_packet_claims {
    bigint id PK
    bigint round_id
    bigint user_id
    int amount_fen
    datetime claimed_at
  }
```
