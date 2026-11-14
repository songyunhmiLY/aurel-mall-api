/** 市场树每个节点的固定子槽数。 */
export const MARKET_TREE_CHILD_SLOTS = 3;

/** market_tree_nodes.path 的列宽。 */
export const MARKET_TREE_MAX_PATH_LENGTH = 2048;

/** 入座时最多重选几次槽位。正常一次成功，重选只发生在并发抢同一槽位时。 */
export const MARKET_TREE_SEAT_ATTEMPTS = 6;

export const MARKET_TREE_SLOTS: readonly number[] = Array.from(
  { length: MARKET_TREE_CHILD_SLOTS },
  (_unused, index) => index + 1,
);
