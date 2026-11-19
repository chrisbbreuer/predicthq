CREATE TABLE IF NOT EXISTS "prediction_checkpoints" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "event_ticker" TEXT NOT NULL,
  "ticker" TEXT NOT NULL,
  "league" TEXT NOT NULL,
  "start_at" TEXT NOT NULL,
  "captured_at" TEXT NOT NULL,
  "settled_at" TEXT NOT NULL DEFAULT '',
  "result" TEXT,
  "payload" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "prediction_checkpoints_event_capture" ON "prediction_checkpoints" ("event_ticker", "captured_at");
CREATE INDEX IF NOT EXISTS "prediction_checkpoints_start" ON "prediction_checkpoints" ("start_at");
CREATE INDEX IF NOT EXISTS "prediction_checkpoints_ticker" ON "prediction_checkpoints" ("ticker");
