-- 槽位的结构性约束。
--
-- (parent_user_id, slot) 唯一索引只保证「同一个位置不会被占两次」，
-- 拦不住 slot 被写成 0、4、或者本该有 slot 却留了 NULL。
-- 这里把两件事变成数据库保证：
--   1. slot 只能是 1、2、3
--   2. 只有根节点（没有父）才没有 slot；其余节点必须有 slot
--
-- 根节点的 slot 为 NULL 是有意的：它上面没有父，也就没有「第几个位置」。
-- MySQL 的唯一索引对 NULL 不生效，所以根不参与 (parent, slot) 唯一性，这是对的。
--
-- 如果这条迁移执行失败，说明库里有父节点挂着 4 个以上孩子（老代码并发写坏的），
-- 迁移 20261114120000 回填 slot 时会给出大于 3 的值。先按下面的语句查出来修数据，
-- 不要为了让迁移通过去放宽约束：
--
--   SELECT parent_user_id, COUNT(*) AS c, GROUP_CONCAT(slot ORDER BY slot) AS slots
--   FROM market_tree_nodes
--   WHERE parent_user_id IS NOT NULL
--   GROUP BY parent_user_id
--   HAVING c > 3 OR MAX(slot) > 3;
--
-- 修法是保留 placed_at 最早的 3 个、把多余的移到有空位的子树里，再重跑本迁移。

ALTER TABLE `market_tree_nodes`
    ADD CONSTRAINT `market_tree_slot_range_ck`
    CHECK (`slot` IS NULL OR (`slot` BETWEEN 1 AND 3));

ALTER TABLE `market_tree_nodes`
    ADD CONSTRAINT `market_tree_root_slot_ck`
    CHECK (
        (`parent_user_id` IS NULL AND `slot` IS NULL)
        OR (`parent_user_id` IS NOT NULL AND `slot` IS NOT NULL)
    );
