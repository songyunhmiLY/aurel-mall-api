-- AlterTable
ALTER TABLE `payments`
    MODIFY `order_id` BIGINT NULL,
    ADD COLUMN `purpose` VARCHAR(32) NOT NULL DEFAULT 'order',
    ADD COLUMN `user_id` BIGINT NULL;

-- CreateIndex
CREATE INDEX `payments_user_purpose_status_idx` ON `payments`(`user_id`, `purpose`, `status`);

-- CreateTable
CREATE TABLE `cofounder_enrollments` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `activation_id` BIGINT NULL,
    `appointed_by_admin_id` BIGINT NULL,
    `enrolled_at` DATETIME(3) NOT NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by_admin_id` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `cofounder_enrollments_user_status_idx`(`user_id`, `status`),
    INDEX `cofounder_enrollments_status_enrolled_idx`(`status`, `enrolled_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cofounder_activations` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `amount_fen` INTEGER NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `payment_id` BIGINT NOT NULL,
    `succeeded_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `cofounder_activations_payment_id_uq`(`payment_id`),
    INDEX `cofounder_activations_user_status_idx`(`user_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cofounder_pools` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `slot` INTEGER NOT NULL,
    `balance_fen` BIGINT NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `cofounder_pools_slot_uq`(`slot`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cofounder_accruals` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `order_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `zone` VARCHAR(32) NOT NULL,
    `base_field` VARCHAR(32) NOT NULL,
    `base_fen` BIGINT NOT NULL,
    `ratio_bps` INTEGER NOT NULL,
    `amount_fen` BIGINT NOT NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `cofounder_accruals_order_id_uq`(`order_id`),
    INDEX `cofounder_accruals_occurred_idx`(`occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cofounder_payout_batches` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `trigger_key` VARCHAR(80) NOT NULL,
    `mode` VARCHAR(32) NOT NULL,
    `total_fen` BIGINT NOT NULL,
    `enrolled_count` INTEGER NOT NULL,
    `share_fen` BIGINT NOT NULL,
    `distributed_fen` BIGINT NOT NULL,
    `retained_fen` BIGINT NOT NULL,
    `paid_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `cofounder_payout_batches_trigger_uq`(`trigger_key`),
    INDEX `cofounder_payout_batches_paid_idx`(`paid_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cofounder_payouts` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `batch_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `amount_fen` BIGINT NOT NULL,
    `credited_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `cofounder_payouts_batch_user_uq`(`batch_id`, `user_id`),
    INDEX `cofounder_payouts_user_credited_idx`(`user_id`, `credited_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cofounder_schedule_slots` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `slot_key` VARCHAR(80) NOT NULL,
    `processed_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `cofounder_schedule_slots_key_uq`(`slot_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
