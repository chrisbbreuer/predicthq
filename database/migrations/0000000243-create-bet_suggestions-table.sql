-- qb:generated
CREATE TABLE IF NOT EXISTS "bet_suggestions" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "kind" TEXT not null,
  "legs" TEXT not null,
  "signature" TEXT not null,
  "stake" REAL not null,
  "price" REAL not null,
  "ev" REAL not null,
  "rationale" TEXT default '',
  "status" TEXT not null default 'pending',
  "expires_at" TEXT not null,
  "decided_at" TEXT default '',
  "outcome" TEXT default '',
  "user_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
CREATE INDEX IF NOT EXISTS "bet_suggestions_user_status" ON "bet_suggestions" ("user_id", "status");
CREATE INDEX IF NOT EXISTS "bet_suggestions_signature" ON "bet_suggestions" ("user_id", "signature");
