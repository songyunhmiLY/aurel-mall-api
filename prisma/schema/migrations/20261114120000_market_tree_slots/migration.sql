-- 市场树槽位化。
-- 目的有两个：
--   1. 「每个节点最多 3 个孩子」改由 (parent_user_id, slot) 唯一索引保证，
--      不再只依赖代码里的计数，并发下不会出现 4 个孩子。
--   2. 找空位不再从上级开始逐层 BFS。第 12 层原本要扫 531441 个节点、
--      拼出 3.7MB 的 IN 列表，现在只查 market_tree_open_slots 里的一行。

-- 1. 加列
ALTER TABLE `market_tree_nodes`
    ADD COLUMN `slot` INTEGER NULL,
    ADD COLUMN `child_count` INTEGER NOT NULL DEFAULT 0;

-- 2. 按 placed_at、id 的顺序给已有节点补槽位（与原有兄弟排序一致）
UPDATE `market_tree_nodes` n
JOIN (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY parent_user_id ORDER BY placed_at, id) AS rn
    FROM `market_tree_nodes`
    WHERE parent_user_id IS NOT NULL
) t ON t.id = n.id
SET n.slot = t.rn;

-- 3. 回填 child_count
UPDATE `market_tree_nodes` n
JOIN (
    SELECT parent_user_id, COUNT(*) AS c
    FROM `market_tree_nodes`
    WHERE parent_user_id IS NOT NULL
    GROUP BY parent_user_id
) t ON t.parent_user_id = n.user_id
SET n.child_count = t.c;

-- 4. 唯一索引：数据库层强制最多 3 个孩子
CREATE UNIQUE INDEX `market_tree_parent_slot_uq` ON `market_tree_nodes`(`parent_user_id`, `slot`);
CREATE INDEX `market_tree_depth_idx` ON `market_tree_nodes`(`depth`);

-- 5. 空闲槽位物化表
CREATE TABLE `market_tree_open_slots` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `parent_user_id` BIGINT NOT NULL,
    `slot` INTEGER NOT NULL,
    `parent_depth` INTEGER NOT NULL,
    `parent_path` VARCHAR(2048) NOT NULL,
    `open_count` INTEGER NOT NULL,

    UNIQUE INDEX `market_tree_open_slot_uq`(`parent_user_id`, `slot`),
    INDEX `market_tree_open_slot_order_idx`(`parent_depth`, `open_count`, `parent_path`(191)),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 6. 按现有 child_count 生成空闲槽位。已经有 4 个孩子的节点不会生成，交由运维修数据。
INSERT INTO `market_tree_open_slots`
    (`parent_user_id`, `slot`, `parent_depth`, `parent_path`, `open_count`)
SELECT n.`user_id`, s.`slot`, n.`depth`, n.`path`, 3 - n.`child_count`
FROM `market_tree_nodes` n
JOIN (SELECT 1 AS `slot` UNION ALL SELECT 2 UNION ALL SELECT 3) s
    ON s.`slot` > n.`child_count`;
