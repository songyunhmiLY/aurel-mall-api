-- AlterTable
ALTER TABLE `red_packet_daily_accruals`
    ADD COLUMN `signup_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `share_fen` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `distributed_fen` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `remainder_fen` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `settled_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `red_packet_signups` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `biz_date` CHAR(10) NOT NULL,
    `signed_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `red_packet_signups_user_biz_date_uq`(`user_id`, `biz_date`),
    INDEX `red_packet_signups_biz_date_user_idx`(`biz_date`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `red_packet_payouts` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `biz_date` CHAR(10) NOT NULL,
    `amount_fen` BIGINT NOT NULL,
    `credited_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `red_packet_payouts_user_biz_date_uq`(`user_id`, `biz_date`),
    INDEX `red_packet_payouts_biz_date_idx`(`biz_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
