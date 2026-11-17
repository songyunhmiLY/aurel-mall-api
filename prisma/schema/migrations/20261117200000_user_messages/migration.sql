-- 站内系统消息：一用户一行，按 users.messages_read_at 判定未读。
CREATE TABLE `user_messages` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `category` VARCHAR(32) NOT NULL,
    `title` VARCHAR(64) NOT NULL,
    `body` VARCHAR(500) NOT NULL,
    `link_page` VARCHAR(255) NULL,
    `biz_type` VARCHAR(32) NULL,
    `biz_id` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL,

    INDEX `user_messages_user_created_idx`(`user_id`, `created_at`),
    INDEX `user_messages_created_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 上次查看系统消息的时间，用于小程序红点。
ALTER TABLE `users` ADD COLUMN `messages_read_at` DATETIME(3) NULL AFTER `seated`;
