CREATE TABLE IF NOT EXISTS "winner_quote_archives" (
  "ticker" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "cutoff_at_ms" INTEGER NOT NULL,
  "league" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "imported_at_ms" INTEGER NOT NULL,
  PRIMARY KEY ("ticker", "source", "cutoff_at_ms")
);
CREATE INDEX IF NOT EXISTS "winner_quote_archives_cutoff" ON "winner_quote_archives" ("cutoff_at_ms");
