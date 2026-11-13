-- 资讯和知识区分文章、新闻、通知。此列出现前的行没有类型，回填为 article。
-- 回填只在本迁移里发生，列上不保留数据库默认值。

ALTER TABLE `articles` ADD COLUMN `kind` VARCHAR(32) NULL;

UPDATE `articles` SET `kind` = 'article' WHERE `kind` IS NULL;

ALTER TABLE `articles`
    MODIFY `kind` VARCHAR(32) NOT NULL,
    ADD INDEX `articles_kind_status_published_idx`(`kind`, `status`, `published_at`);
