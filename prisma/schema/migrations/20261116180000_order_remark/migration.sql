-- 订单运营备注：人工强制完成结算时写入钱包缺口与入座处理说明。
ALTER TABLE `orders` ADD COLUMN `remark` VARCHAR(255) NULL AFTER `tracking_no`;
