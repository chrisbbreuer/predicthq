CREATE TABLE IF NOT EXISTS `dead_letter_jobs` (
  `id` bigint PRIMARY KEY auto_increment,
  `uuid` varchar(255) not null,
  `connection` varchar(255) not null,
  `queue` varchar(255) not null,
  `payload` longtext not null,
  `exception` longtext not null,
  `reason` varchar(64) not null,
  `total_failures` integer not null default 1,
  `first_failed_at` datetime,
  `last_failed_at` datetime,
  `dead_lettered_at` datetime not null default CURRENT_TIMESTAMP
);
CREATE INDEX `dead_letter_jobs_queue_index` ON `dead_letter_jobs` (`queue`, `dead_lettered_at`);

CREATE TABLE IF NOT EXISTS `job_quarantine` (
  `id` bigint PRIMARY KEY auto_increment,
  `job_name` varchar(255) not null,
  `payload_hash` varchar(64) not null,
  `failure_count` integer not null default 0,
  `window_start` datetime not null default CURRENT_TIMESTAMP,
  `quarantined_at` datetime
);
CREATE UNIQUE INDEX `job_quarantine_job_payload_unique` ON `job_quarantine` (`job_name`, `payload_hash`);

CREATE TABLE IF NOT EXISTS `queue_circuit_state` (
  `queue_name` varchar(255) PRIMARY KEY,
  `success_count` integer not null default 0,
  `failure_count` integer not null default 0,
  `window_start` datetime not null default CURRENT_TIMESTAMP,
  `paused_at` datetime,
  `resume_at` datetime
);

CREATE TABLE IF NOT EXISTS `job_idempotency` (
  `id` bigint PRIMARY KEY auto_increment,
  `idempotency_key` varchar(255) not null,
  `job_name` varchar(255) not null,
  `queue` varchar(255) not null default 'default',
  `dispatched_at` datetime not null default CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX `job_idempotency_key_unique` ON `job_idempotency` (`idempotency_key`);

CREATE INDEX `jobs_queue_availability_index` ON `jobs` (`queue`, `reserved_at`, `available_at`);
