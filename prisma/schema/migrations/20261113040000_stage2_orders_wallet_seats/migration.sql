-- AlterTable
ALTER TABLE `users`
    ADD COLUMN `member` BOOLEAN NULL,
    ADD COLUMN `seated` BOOLEAN NULL;

-- Backfill membership from existing market seats. Root is the only seated user so far.
UPDATE `users` AS u
LEFT JOIN `market_tree_nodes` AS m ON m.user_id = u.id
SET u.`member` = IF(m.id IS NULL, FALSE, TRUE),
    u.`seated` = IF(m.id IS NULL, FALSE, TRUE);

-- AlterTable
ALTER TABLE `users`
    MODIFY `member` BOOLEAN NOT NULL,
    MODIFY `seated` BOOLEAN NOT NULL;

-- AlterTable
ALTER TABLE `orders`
    ADD COLUMN `freight_fen` INTEGER NULL,
    ADD COLUMN `pv_fen` INTEGER NULL,
    ADD COLUMN `points_fen` INTEGER NULL,
    ADD COLUMN `withdrawable_fen` INTEGER NULL,
    ADD COLUMN `consumption_fen` INTEGER NULL,
    ADD COLUMN `wechat_fen` INTEGER NULL,
    ADD COLUMN `contact_name` VARCHAR(64) NULL,
    ADD COLUMN `contact_phone` VARCHAR(32) NULL,
    ADD COLUMN `province` VARCHAR(32) NULL,
    ADD COLUMN `city` VARCHAR(32) NULL,
    ADD COLUMN `district` VARCHAR(32) NULL,
    ADD COLUMN `detail` VARCHAR(255) NULL,
    ADD COLUMN `courier_name` VARCHAR(64) NULL,
    ADD COLUMN `tracking_no` VARCHAR(64) NULL,
    ADD COLUMN `shipped_at` DATETIME(3) NULL;

-- Existing orders were created before wallet split. Charge the whole payable by WeChat.
UPDATE `orders`
SET `freight_fen` = 0,
    `pv_fen` = 0,
    `points_fen` = 0,
    `withdrawable_fen` = 0,
    `consumption_fen` = 0,
    `wechat_fen` = `pay_amount_fen`,
    `contact_name` = '',
    `contact_phone` = '',
    `province` = '',
    `city` = '',
    `district` = '',
    `detail` = ''
WHERE `freight_fen` IS NULL;

-- AlterTable
ALTER TABLE `orders`
    MODIFY `freight_fen` INTEGER NOT NULL,
    MODIFY `pv_fen` INTEGER NOT NULL,
    MODIFY `points_fen` INTEGER NOT NULL,
    MODIFY `withdrawable_fen` INTEGER NOT NULL,
    MODIFY `consumption_fen` INTEGER NOT NULL,
    MODIFY `wechat_fen` INTEGER NOT NULL,
    MODIFY `contact_name` VARCHAR(64) NOT NULL,
    MODIFY `contact_phone` VARCHAR(32) NOT NULL,
    MODIFY `province` VARCHAR(32) NOT NULL,
    MODIFY `city` VARCHAR(32) NOT NULL,
    MODIFY `district` VARCHAR(32) NOT NULL,
    MODIFY `detail` VARCHAR(255) NOT NULL;

-- CreateIndex
CREATE INDEX `orders_zone_status_idx` ON `orders`(`zone`, `status`);

-- AlterTable
ALTER TABLE `order_items`
    ADD COLUMN `pv_fen` INTEGER NULL,
    ADD COLUMN `freight_fen` INTEGER NULL;

UPDATE `order_items`
SET `pv_fen` = 0,
    `freight_fen` = 0
WHERE `pv_fen` IS NULL;

-- AlterTable
ALTER TABLE `order_items`
    MODIFY `pv_fen` INTEGER NOT NULL,
    MODIFY `freight_fen` INTEGER NOT NULL;

-- AlterTable
ALTER TABLE `wallet_accounts` ADD COLUMN `frozen_fen` BIGINT NULL;

UPDATE `wallet_accounts` SET `frozen_fen` = 0 WHERE `frozen_fen` IS NULL;

-- AlterTable
ALTER TABLE `wallet_accounts` MODIFY `frozen_fen` BIGINT NOT NULL;

-- CreateTable
CREATE TABLE `wallet_holds` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `order_id` BIGINT NOT NULL,
    `user_id` BIGINT NOT NULL,
    `wallet_type` VARCHAR(32) NOT NULL,
    `amount_fen` BIGINT NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `wallet_holds_order_type_uq`(`order_id`, `wallet_type`),
    INDEX `wallet_holds_user_status_idx`(`user_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
