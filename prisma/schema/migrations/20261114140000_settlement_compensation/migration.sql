-- 结算补偿表。微信已扣款但本地结算事务失败时登记，定时重试或人工继续结算。
CREATE TABLE `settlement_compensations` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `order_id` BIGINT NOT NULL,
    `pay_no` VARCHAR(64) NOT NULL,
    `user_id` BIGINT NOT NULL,
    `zone` VARCHAR(32) NOT NULL,
    `wechat_trade_no` VARCHAR(64) NULL,
    `amount_fen` INTEGER NOT NULL,
    `fail_reason` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `last_error` VARCHAR(255) NULL,
    `last_tried_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `refunded_at` DATETIME(3) NULL,
    `operator_admin_id` BIGINT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `settlement_compensations_order_id_uq`(`order_id`),
    INDEX `settlement_compensations_status_tried_idx`(`status`, `last_tried_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
