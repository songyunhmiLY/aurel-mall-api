-- 商品成本价（含运费口径，可空）与订单行成本快照。
ALTER TABLE `product_skus`
    ADD COLUMN `cost_fen` INTEGER NULL;

ALTER TABLE `order_items`
    ADD COLUMN `unit_cost_fen` INTEGER NULL;
