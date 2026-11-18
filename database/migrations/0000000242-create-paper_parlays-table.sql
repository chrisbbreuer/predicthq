-- qb:generated
CREATE TABLE IF NOT EXISTS "paper_parlays" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "legs" TEXT not null,
  "stake" REAL not null,
  "price" REAL not null,
  "status" TEXT not null default 'open',
  "payout" REAL default 0,
  "rationale" TEXT default '',
  "placed_at" TEXT not null,
  "settled_at" TEXT default '',
  "user_id" INTEGER,
  "trading_strategy_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
CREATE INDEX IF NOT EXISTS "paper_parlays_user_status" ON "paper_parlays" ("user_id", "status");
