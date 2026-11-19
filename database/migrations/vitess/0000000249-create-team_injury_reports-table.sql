CREATE TABLE IF NOT EXISTS `team_injury_reports` (
  `id` bigint PRIMARY KEY auto_increment,
  `sports_team_id` bigint,
  `injuries` longtext NOT NULL,
  `source` varchar(40) NOT NULL,
  `captured_at` varchar(40) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT (UTC_TIMESTAMP),
  `updated_at` datetime
) DEFAULT CHARSET=utf8mb4;
CREATE INDEX `team_injury_reports_team_captured` ON `team_injury_reports` (`sports_team_id`, `captured_at`);
