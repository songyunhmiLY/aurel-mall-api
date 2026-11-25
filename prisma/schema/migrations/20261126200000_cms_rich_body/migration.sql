-- 资讯和知识正文升级为富文本：正文列放宽到 MEDIUMTEXT，新增富文本插图存储表。
ALTER TABLE `articles` MODIFY `body` MEDIUMTEXT NOT NULL;

-- 联创介绍、福利专场入口文案也存在 admin_settings 的 value 里，一并放宽。
ALTER TABLE `admin_settings` MODIFY `setting_value` MEDIUMTEXT NOT NULL;

-- 富文本插图：原图字节直接入库，公开只读接口按 id 供图。
CREATE TABLE `cms_images` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `mime` VARCHAR(64) NOT NULL,
    `size_bytes` INT NOT NULL,
    `data` LONGBLOB NOT NULL,
    `created_at` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
