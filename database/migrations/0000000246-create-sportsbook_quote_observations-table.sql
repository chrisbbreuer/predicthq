CREATE TABLE IF NOT EXISTS "sportsbook_quote_observations" (
  "selection_id" INTEGER NOT NULL,
  "bookmaker_id" INTEGER NOT NULL,
  "checked_at_ms" INTEGER NOT NULL,
  "observed_at" TEXT,
  "price" REAL NOT NULL,
  "point" REAL,
  "available" INTEGER NOT NULL,
  "source" TEXT NOT NULL,
  PRIMARY KEY ("selection_id", "bookmaker_id", "checked_at_ms")
);
CREATE INDEX IF NOT EXISTS "sportsbook_quote_observations_checked" ON "sportsbook_quote_observations" ("checked_at_ms");
