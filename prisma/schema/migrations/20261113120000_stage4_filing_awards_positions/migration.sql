-- CreateTable
CREATE TABLE `startup_sub_orders` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `order_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `order_at` DATETIME(3) NOT NULL,
    `paid_at` DATETIME(3) NOT NULL,
    `amount_fen` INTEGER NOT NULL,
    `filed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `startup_sub_orders_user_filed_idx`(`user_id`, `filed_at`),
    INDEX `startup_sub_orders_order_id_idx`(`order_id`),
    INDEX `startup_sub_orders_order_at_idx`(`order_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `filings`
    ADD COLUMN `sub_order_id` BIGINT NULL,
    ADD COLUMN `sequence` INTEGER NULL,
    ADD COLUMN `biz_date` CHAR(10) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `filings_sub_order_id_uq` ON `filings`(`sub_order_id`);

-- CreateIndex
CREATE UNIQUE INDEX `filings_sequence_uq` ON `filings`(`sequence`);

-- CreateIndex
CREATE UNIQUE INDEX `filings_user_biz_date_uq` ON `filings`(`user_id`, `biz_date`);

-- CreateTable
CREATE TABLE `filing_counters` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `slot` INTEGER NOT NULL,
    `last_sequence` INTEGER NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `filing_counters_slot_uq`(`slot`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `filing_daily_checks` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `biz_date` CHAR(10) NOT NULL,
    `finished_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `filing_daily_checks_biz_date_uq`(`biz_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `filing_settlements` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `trigger_sequence` INTEGER NOT NULL,
    `beneficiary_filing_id` BIGINT NOT NULL,
    `beneficiary_user_id` BIGINT NOT NULL,
    `points_fen` BIGINT NOT NULL,
    `withdrawable_fen` BIGINT NOT NULL,
    `unit_price_fen` INTEGER NOT NULL,
    `withdrawal_ratio_bps` INTEGER NOT NULL,
    `settled_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `filing_settlements_trigger_sequence_uq`(`trigger_sequence`),
    UNIQUE INDEX `filing_settlements_beneficiary_uq`(`beneficiary_filing_id`),
    INDEX `filing_settlements_user_idx`(`beneficiary_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `reward_ledger_entries`
    ADD COLUMN `order_id` BIGINT NULL,
    ADD COLUMN `layer` INTEGER NULL;

-- CreateIndex
CREATE UNIQUE INDEX `reward_ledger_biz_uq` ON `reward_ledger_entries`(`user_id`, `reward_type`, `biz_type`, `biz_id`);

-- CreateIndex
CREATE INDEX `reward_ledger_order_type_idx` ON `reward_ledger_entries`(`order_id`, `reward_type`);

-- CreateIndex
CREATE INDEX `reward_ledger_user_type_layer_idx` ON `reward_ledger_entries`(`user_id`, `reward_type`, `layer`);

-- CreateIndex
CREATE UNIQUE INDEX `wallet_ledger_credit_biz_uq` ON `wallet_ledger_entries`(`user_id`, `wallet_type`, `direction`, `biz_type`, `biz_id`);

-- CreateTable
CREATE TABLE `market_threshold_revisions` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `effective_month` CHAR(7) NOT NULL,
    `threshold_fen` BIGINT NOT NULL,
    `updated_by_admin_id` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `market_threshold_revisions_month_uq`(`effective_month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `position_dividend_periods` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `performance_month` CHAR(7) NOT NULL,
    `payout_date` CHAR(10) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `mall_pv_fen` BIGINT NULL,
    `auto_paid_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `position_dividend_periods_month_uq`(`performance_month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `position_dividend_exclusions` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `period_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `removed_by_admin_id` BIGINT NOT NULL,
    `removed_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `position_dividend_exclusions_period_user_uq`(`period_id`, `user_id`),
    INDEX `position_dividend_exclusions_user_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `position_dividend_records` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `period_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `position_code` VARCHAR(32) NOT NULL,
    `mode` VARCHAR(16) NOT NULL,
    `original_amount_fen` BIGINT NOT NULL,
    `actual_amount_fen` BIGINT NOT NULL,
    `remark` VARCHAR(200) NULL,
    `admin_id` BIGINT NULL,
    `paid_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `position_dividend_records_slot_uq`(`period_id`, `user_id`, `position_code`),
    INDEX `position_dividend_records_period_paid_idx`(`period_id`, `paid_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
