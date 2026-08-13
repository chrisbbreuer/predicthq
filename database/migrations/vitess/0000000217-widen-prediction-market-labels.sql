ALTER TABLE `prediction_markets` MODIFY COLUMN `question` varchar(2048);
ALTER TABLE `prediction_markets` MODIFY COLUMN `outcome_label` varchar(2048) DEFAULT '';
