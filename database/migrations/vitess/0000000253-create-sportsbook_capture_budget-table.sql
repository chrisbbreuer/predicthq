CREATE TABLE IF NOT EXISTS `sportsbook_capture_budget` (
  `bucket_ms` bigint NOT NULL PRIMARY KEY,
  `requests` int NOT NULL
) DEFAULT CHARSET=utf8mb4;
