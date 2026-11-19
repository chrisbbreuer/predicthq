CREATE TABLE IF NOT EXISTS `sportsbook_quote_observations` (
  `selection_id` bigint NOT NULL,
  `bookmaker_id` bigint NOT NULL,
  `checked_at_ms` bigint NOT NULL,
  `observed_at` varchar(40),
  `price` decimal(20,8) NOT NULL,
  `point` decimal(12,4),
  `available` tinyint NOT NULL,
  `source` varchar(40) NOT NULL,
  PRIMARY KEY (`selection_id`, `bookmaker_id`, `checked_at_ms`),
  INDEX `sportsbook_quote_observations_checked` (`checked_at_ms`)
) DEFAULT CHARSET=utf8mb4;
