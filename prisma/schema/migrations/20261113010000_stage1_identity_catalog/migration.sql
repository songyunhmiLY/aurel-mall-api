-- AlterTable
ALTER TABLE `users` ADD COLUMN `phone` VARCHAR(32) NULL,
    ADD COLUMN `invite_code` VARCHAR(32) NULL;

-- CreateIndex
CREATE INDEX `users_phone_idx` ON `users`(`phone`);

-- CreateIndex
CREATE UNIQUE INDEX `users_invite_code_uq` ON `users`(`invite_code`);

-- AlterTable
ALTER TABLE `user_identities` ADD COLUMN `union_id` VARCHAR(128) NULL;

-- CreateTable
CREATE TABLE `user_kyc` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `real_name` VARCHAR(64) NOT NULL,
    `id_number` CHAR(18) NOT NULL,
    `mobile` VARCHAR(20) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `submitted_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `user_kyc_user_id_uq`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `products` ADD COLUMN `body` TEXT NULL,
    ADD COLUMN `freight_fen` INTEGER NULL,
    ADD COLUMN `category_id` BIGINT NULL;

-- Backfill freight for any rows created before this column existed.
UPDATE `products` SET `freight_fen` = 0 WHERE `freight_fen` IS NULL;

-- AlterTable
ALTER TABLE `products` MODIFY `freight_fen` INTEGER NOT NULL;

-- CreateIndex
CREATE INDEX `products_category_id_idx` ON `products`(`category_id`);

-- AlterTable
ALTER TABLE `product_skus` ADD COLUMN `pv_fen` INTEGER NULL;

-- CreateTable
CREATE TABLE `mall_categories` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(64) NOT NULL,
    `sort_order` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `mall_categories_sort_order_idx`(`sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_images` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `product_id` BIGINT NOT NULL,
    `url` VARCHAR(512) NOT NULL,
    `sort_order` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `product_images_product_sort_idx`(`product_id`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
