-- AlterTable
ALTER TABLE `wallet_ledger_entries`
    ADD COLUMN `source_code` VARCHAR(64) NULL;

-- CreateIndex
CREATE INDEX `wallet_ledger_user_type_source_idx` ON `wallet_ledger_entries`(`user_id`, `wallet_type`, `source_code`);

-- CreateTable
CREATE TABLE `consumption_transfers` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `payer_user_id` BIGINT NOT NULL,
    `payee_user_id` BIGINT NOT NULL,
    `amount_fen` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `consumption_transfers_payer_idx`(`payer_user_id`, `created_at`),
    INDEX `consumption_transfers_payee_idx`(`payee_user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_payment_passwords` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `user_payment_passwords_user_id_uq`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_bank_accounts` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `account_name` VARCHAR(64) NOT NULL,
    `bank_name` VARCHAR(64) NOT NULL,
    `account_no` VARCHAR(32) NOT NULL,
    `branch_name` VARCHAR(128) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `user_bank_accounts_user_id_uq`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `withdrawal_applications` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `amount_fen` BIGINT NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `account_name` VARCHAR(64) NOT NULL,
    `bank_name` VARCHAR(64) NOT NULL,
    `account_no` VARCHAR(32) NOT NULL,
    `branch_name` VARCHAR(128) NOT NULL,
    `applied_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `withdrawal_applications_user_status_idx`(`user_id`, `status`),
    INDEX `withdrawal_applications_status_applied_idx`(`status`, `applied_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `withdrawal_settlements` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `application_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `outcome` VARCHAR(32) NOT NULL,
    `amount_fen` BIGINT NOT NULL,
    `fee_fen` BIGINT NULL,
    `payout_fen` BIGINT NULL,
    `admin_id` BIGINT NOT NULL,
    `settled_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `withdrawal_settlements_application_id_uq`(`application_id`),
    INDEX `withdrawal_settlements_user_settled_idx`(`user_id`, `settled_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
-- TODO(section 4.1): the official seven Chinese display names are not in this repo.
-- Placeholder labels equal the reserved reward source codes. Admins can rename them.
CREATE TABLE `withdrawal_display_sources` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `source_code` VARCHAR(64) NOT NULL,
    `display_name` VARCHAR(64) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `updated_by_admin_id` BIGINT NULL,

    UNIQUE INDEX `withdrawal_display_sources_source_code_uq`(`source_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `withdrawal_display_sources` (`source_code`, `display_name`, `updated_at`, `updated_by_admin_id`)
VALUES
    ('startup_sales', 'startup_sales', '2026-11-13 00:00:00.000', NULL),
    ('startup_points', 'startup_points', '2026-11-13 00:00:00.000', NULL),
    ('mall_sales', 'mall_sales', '2026-11-13 00:00:00.000', NULL),
    ('mall_points', 'mall_points', '2026-11-13 00:00:00.000', NULL),
    ('position_dividend', 'position_dividend', '2026-11-13 00:00:00.000', NULL),
    ('cofounder', 'cofounder', '2026-11-13 00:00:00.000', NULL),
    ('studio', 'studio', '2026-11-13 00:00:00.000', NULL),
    ('operations', 'operations', '2026-11-13 00:00:00.000', NULL),
    ('red_packet', 'red_packet', '2026-11-13 00:00:00.000', NULL);

-- CreateTable
CREATE TABLE `cash_ledger_entries` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `direction` VARCHAR(16) NOT NULL,
    `amount_fen` BIGINT NOT NULL,
    `biz_type` VARCHAR(64) NOT NULL,
    `biz_id` VARCHAR(64) NOT NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `cash_ledger_biz_idx`(`biz_type`, `biz_id`),
    INDEX `cash_ledger_occurred_idx`(`occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_refunds` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `order_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `pay_amount_fen` INTEGER NOT NULL,
    `freight_fen` INTEGER NOT NULL,
    `refund_fen` INTEGER NULL,
    `deduction_fen` INTEGER NULL,
    `wechat_refund_fen` INTEGER NULL,
    `withdrawable_deduction_fen` INTEGER NULL,
    `consumption_credit_fen` INTEGER NULL,
    `wechat_refund_status` VARCHAR(32) NULL,
    `wechat_refund_no` VARCHAR(64) NULL,
    `applied_at` DATETIME(3) NOT NULL,
    `decided_at` DATETIME(3) NULL,
    `decided_by_admin_id` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `order_refunds_wechat_refund_no_uq`(`wechat_refund_no`),
    INDEX `order_refunds_user_status_idx`(`user_id`, `status`),
    INDEX `order_refunds_order_status_idx`(`order_id`, `status`),
    INDEX `order_refunds_status_applied_idx`(`status`, `applied_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
