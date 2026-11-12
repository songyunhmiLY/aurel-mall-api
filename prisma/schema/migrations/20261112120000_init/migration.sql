-- CreateTable
CREATE TABLE `products` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `zone` VARCHAR(32) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `subtitle` VARCHAR(255) NULL,
    `cover_url` VARCHAR(512) NULL,
    `status` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `products_zone_status_idx`(`zone`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_skus` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `product_id` BIGINT NOT NULL,
    `sku_code` VARCHAR(64) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `price_fen` INTEGER NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `product_skus_sku_code_uq`(`sku_code`),
    INDEX `product_skus_product_id_idx`(`product_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sku_stocks` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `sku_id` BIGINT NOT NULL,
    `quantity` INTEGER NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sku_stocks_sku_id_uq`(`sku_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `banners` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(128) NOT NULL,
    `image_url` VARCHAR(512) NOT NULL,
    `link_url` VARCHAR(512) NULL,
    `sort_order` INTEGER NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `banners_status_sort_idx`(`status`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `articles` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(200) NOT NULL,
    `summary` VARCHAR(500) NOT NULL,
    `body` TEXT NOT NULL,
    `cover_url` VARCHAR(512) NULL,
    `status` VARCHAR(32) NOT NULL,
    `published_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `articles_status_published_idx`(`status`, `published_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tickers` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `content` VARCHAR(255) NOT NULL,
    `sort_order` INTEGER NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `tickers_status_sort_idx`(`status`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `status` VARCHAR(32) NOT NULL,
    `nickname` VARCHAR(64) NOT NULL,
    `avatar_url` VARCHAR(512) NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `users_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_identities` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `identifier` VARCHAR(128) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `user_identities_user_id_idx`(`user_id`),
    UNIQUE INDEX `user_identities_provider_identifier_uq`(`provider`, `identifier`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_users` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(64) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `display_name` VARCHAR(64) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `admin_users_username_uq`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_addresses` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `contact_name` VARCHAR(64) NOT NULL,
    `contact_phone` VARCHAR(32) NOT NULL,
    `province` VARCHAR(32) NOT NULL,
    `city` VARCHAR(32) NOT NULL,
    `district` VARCHAR(32) NOT NULL,
    `detail` VARCHAR(255) NOT NULL,
    `is_default` BOOLEAN NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `user_addresses_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `orders` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `order_no` VARCHAR(32) NOT NULL,
    `user_id` BIGINT NOT NULL,
    `zone` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `goods_total_fen` INTEGER NOT NULL,
    `pay_amount_fen` INTEGER NOT NULL,
    `placed_at` DATETIME(3) NOT NULL,
    `paid_at` DATETIME(3) NULL,
    `closed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `orders_order_no_uq`(`order_no`),
    INDEX `orders_user_id_placed_at_idx`(`user_id`, `placed_at`),
    INDEX `orders_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_items` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `order_id` BIGINT NOT NULL,
    `sku_id` BIGINT NOT NULL,
    `product_name` VARCHAR(128) NOT NULL,
    `sku_name` VARCHAR(128) NOT NULL,
    `unit_price_fen` INTEGER NOT NULL,
    `quantity` INTEGER NOT NULL,
    `line_total_fen` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `order_items_order_id_idx`(`order_id`),
    INDEX `order_items_sku_id_idx`(`sku_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `order_id` BIGINT NOT NULL,
    `pay_no` VARCHAR(64) NOT NULL,
    `channel` VARCHAR(32) NOT NULL,
    `amount_fen` INTEGER NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `succeeded_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payments_pay_no_uq`(`pay_no`),
    INDEX `payments_order_id_idx`(`order_id`),
    INDEX `payments_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invite_tree_nodes` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `parent_user_id` BIGINT NULL,
    `depth` INTEGER NOT NULL,
    `path` VARCHAR(2048) NOT NULL,
    `joined_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `invite_tree_user_id_uq`(`user_id`),
    INDEX `invite_tree_parent_user_id_idx`(`parent_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `market_tree_nodes` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `parent_user_id` BIGINT NULL,
    `depth` INTEGER NOT NULL,
    `path` VARCHAR(2048) NOT NULL,
    `placed_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `market_tree_user_id_uq`(`user_id`),
    INDEX `market_tree_parent_user_id_idx`(`parent_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `filings` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `filing_no` VARCHAR(32) NOT NULL,
    `user_id` BIGINT NOT NULL,
    `order_id` BIGINT NULL,
    `status` VARCHAR(32) NOT NULL,
    `amount_fen` INTEGER NOT NULL,
    `filed_at` DATETIME(3) NULL,
    `settled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `filings_filing_no_uq`(`filing_no`),
    INDEX `filings_user_id_filed_at_idx`(`user_id`, `filed_at`),
    INDEX `filings_order_id_idx`(`order_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reward_ledger_entries` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `reward_type` VARCHAR(64) NOT NULL,
    `amount_fen` BIGINT NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `biz_type` VARCHAR(64) NOT NULL,
    `biz_id` VARCHAR(64) NOT NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `reward_ledger_user_occurred_idx`(`user_id`, `occurred_at`),
    INDEX `reward_ledger_type_occurred_idx`(`reward_type`, `occurred_at`),
    INDEX `reward_ledger_biz_idx`(`biz_type`, `biz_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `positions` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `rank_level` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `positions_code_uq`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_positions` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `position_id` BIGINT NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `granted_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `user_positions_user_status_idx`(`user_id`, `status`),
    INDEX `user_positions_position_id_idx`(`position_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `red_packet_daily_accruals` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `biz_date` CHAR(10) NOT NULL,
    `startup_sales_fen` BIGINT NOT NULL,
    `accrual_fen` BIGINT NOT NULL,
    `accrued_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `red_packet_daily_biz_date_uq`(`biz_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `red_packet_rounds` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `round_no` INTEGER NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `pay_threshold_fen` INTEGER NOT NULL,
    `claim_cap_fen` INTEGER NOT NULL,
    `opened_at` DATETIME(3) NULL,
    `closed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `red_packet_rounds_round_no_uq`(`round_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `red_packet_claims` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `round_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `amount_fen` INTEGER NOT NULL,
    `claimed_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `red_packet_claims_round_user_idx`(`round_id`, `user_id`),
    INDEX `red_packet_claims_user_claimed_idx`(`user_id`, `claimed_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_settings` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `setting_key` VARCHAR(64) NOT NULL,
    `setting_value` VARCHAR(255) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by_admin_id` BIGINT NULL,

    UNIQUE INDEX `admin_settings_setting_key_uq`(`setting_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallet_accounts` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `wallet_type` VARCHAR(32) NOT NULL,
    `balance_fen` BIGINT NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `wallet_accounts_user_type_uq`(`user_id`, `wallet_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallet_ledger_entries` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `account_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `wallet_type` VARCHAR(32) NOT NULL,
    `direction` VARCHAR(16) NOT NULL,
    `amount_fen` BIGINT NOT NULL,
    `balance_after_fen` BIGINT NOT NULL,
    `biz_type` VARCHAR(64) NOT NULL,
    `biz_id` VARCHAR(64) NOT NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `wallet_ledger_account_occurred_idx`(`account_id`, `occurred_at`),
    INDEX `wallet_ledger_user_occurred_idx`(`user_id`, `occurred_at`),
    INDEX `wallet_ledger_biz_idx`(`biz_type`, `biz_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

