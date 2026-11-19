CREATE TABLE IF NOT EXISTS `prediction_checkpoints` (
  `id` bigint PRIMARY KEY auto_increment,
  `event_ticker` varchar(80) NOT NULL,
  `ticker` varchar(80) NOT NULL,
  `league` varchar(32) NOT NULL,
  `start_at` datetime NOT NULL,
  `captured_at` datetime NOT NULL,
  `settled_at` varchar(40) NOT NULL DEFAULT '',
  `result` varchar(8),
  `payload` longtext NOT NULL,
  `created_at` datetime NOT NULL,
  UNIQUE INDEX `prediction_checkpoints_event_capture` (`event_ticker`, `captured_at`),
  INDEX `prediction_checkpoints_start` (`start_at`),
  INDEX `prediction_checkpoints_ticker` (`ticker`)
) DEFAULT CHARSET=utf8mb4;
