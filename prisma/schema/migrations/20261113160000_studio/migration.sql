-- CreateTable
CREATE TABLE `studio_enrollments` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `appointed_by_admin_id` BIGINT NOT NULL,
    `enrolled_at` DATETIME(3) NOT NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by_admin_id` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `studio_enrollments_user_status_idx`(`user_id`, `status`),
    INDEX `studio_enrollments_status_enrolled_idx`(`status`, `enrolled_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `studio_accruals` (
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

    UNIQUE INDEX `studio_accruals_order_user_uq`(`order_id`, `user_id`),
    INDEX `studio_accruals_user_occurred_idx`(`user_id`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
