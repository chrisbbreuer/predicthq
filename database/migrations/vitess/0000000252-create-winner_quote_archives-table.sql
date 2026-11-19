CREATE TABLE IF NOT EXISTS `winner_quote_archives` (
  `ticker` varchar(100) NOT NULL,
  `source` varchar(32) NOT NULL,
  `cutoff_at_ms` bigint NOT NULL,
  `league` varchar(32) NOT NULL,
  `payload` longtext NOT NULL,
  `imported_at_ms` bigint NOT NULL,
  PRIMARY KEY (`ticker`, `source`, `cutoff_at_ms`),
  INDEX `winner_quote_archives_cutoff` (`cutoff_at_ms`)
) DEFAULT CHARSET=utf8mb4;
