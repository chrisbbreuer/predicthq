CREATE INDEX IF NOT EXISTS "markets_market_event_id" ON "markets" ("market_event_id");
DROP INDEX IF EXISTS "markets_event_type_line_period";
