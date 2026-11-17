-- 商城混排顺序由管理端配置；首页商品流由管理端逐件勾选。
ALTER TABLE `products`
    ADD COLUMN `sort_order` INT NOT NULL DEFAULT 0 AFTER `status`,
    ADD COLUMN `home_visible` BOOLEAN NOT NULL DEFAULT false AFTER `sort_order`;

CREATE INDEX `products_status_sort_idx` ON `products`(`status`, `sort_order`);

-- 已经在售的商品默认进首页：升级瞬间不要出现「首页商品流空了」。
-- 运营再按需要逐件取消勾选，而不是从零开始勾。
UPDATE `products` SET `home_visible` = true WHERE `status` = 'on';
