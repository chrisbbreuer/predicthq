-- qb:generated
CREATE TABLE IF NOT EXISTS `line_snapshots` (
  `id` bigint PRIMARY KEY auto_increment,
  `ticker` varchar(80) not null,
  `league` varchar(20) not null,
  `espn_game_id` varchar(20) not null,
  `side` varchar(255) not null,
  `provider` varchar(40) default '',
  `book_prob` decimal(6,4) not null,
  `kalshi_bid` decimal(6,4) not null,
  `kalshi_ask` decimal(6,4) not null,
  `minutes_to_start` integer not null,
  `starts_at` varchar(40) not null,
  `recorded_at` varchar(40) not null,
  `created_at` datetime not null default (UTC_TIMESTAMP),
  `updated_at` datetime
) DEFAULT CHARSET=utf8mb4;
CREATE INDEX `line_snapshots_ticker_recorded` ON `line_snapshots` (`ticker`, `recorded_at`);
CREATE INDEX `line_snapshots_recorded` ON `line_snapshots` (`recorded_at`);
