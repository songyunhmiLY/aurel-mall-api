-- AlterTable
ALTER TABLE `admin_settings` MODIFY `setting_value` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `payments` ADD COLUMN `channel_trade_no` VARCHAR(64) NULL,
    ADD COLUMN `prepay_id` VARCHAR(64) NULL,
    ADD COLUMN `active_slot` VARCHAR(64) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `payments_channel_trade_no_uq` ON `payments`(`channel_trade_no`);

-- CreateIndex
CREATE UNIQUE INDEX `payments_active_slot_uq` ON `payments`(`active_slot`);
