-- qb:generated
CREATE TABLE IF NOT EXISTS "line_snapshots" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "ticker" TEXT not null,
  "league" TEXT not null,
  "espn_game_id" TEXT not null,
  "side" TEXT not null,
  "provider" TEXT default '',
  "book_prob" REAL not null,
  "kalshi_bid" REAL not null,
  "kalshi_ask" REAL not null,
  "minutes_to_start" INTEGER not null,
  "starts_at" TEXT not null,
  "recorded_at" TEXT not null,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
CREATE INDEX IF NOT EXISTS "line_snapshots_ticker_recorded" ON "line_snapshots" ("ticker", "recorded_at");
CREATE INDEX IF NOT EXISTS "line_snapshots_recorded" ON "line_snapshots" ("recorded_at");
