ALTER TABLE `oauth_access_tokens` ADD COLUMN `user_agent` varchar(500);
ALTER TABLE `oauth_access_tokens` ADD COLUMN `ip_address` varchar(45);
