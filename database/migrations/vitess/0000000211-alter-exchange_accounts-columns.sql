ALTER TABLE `exchange_accounts` MODIFY COLUMN `credentials` TEXT;
ALTER TABLE `exchange_accounts` ADD COLUMN `terms_accepted_at` varchar(40) DEFAULT '';
ALTER TABLE `exchange_accounts` ADD COLUMN `risk_accepted_at` varchar(40) DEFAULT '';
ALTER TABLE `exchange_accounts` ADD COLUMN `age_confirmed_at` varchar(40) DEFAULT '';
ALTER TABLE `exchange_accounts` ADD COLUMN `jurisdiction` varchar(8) DEFAULT '';
