-- CreateTable
CREATE TABLE `red_packet_pool_overrides` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `biz_date` CHAR(10) NOT NULL,
    `amount_fen` BIGINT NOT NULL,
    `updated_by_admin_id` BIGINT NULL,
    `updated_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `red_packet_pool_overrides_biz_date_uq`(`biz_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
