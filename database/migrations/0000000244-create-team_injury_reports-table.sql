CREATE TABLE IF NOT EXISTS "team_injury_reports" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "sports_team_id" INTEGER,
  "injuries" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "captured_at" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
CREATE INDEX IF NOT EXISTS "team_injury_reports_team_captured" ON "team_injury_reports" ("sports_team_id", "captured_at");
