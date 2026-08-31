import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("discovery track record migration", () => {
  it("classifies unknown provenance as legacy before already trending", () => {
    const migration = readFileSync(new URL("./007_discovery_track_record.sql", import.meta.url), "utf8");
    const legacyOutcome = "when first_observation_sources is null then 'legacy'";
    const alreadyTrendingOutcome = "when first_official_daily_at = first_observed_at then 'already_trending'";

    expect(migration.indexOf(legacyOutcome)).toBeGreaterThan(-1);
    expect(migration.indexOf(alreadyTrendingOutcome)).toBeGreaterThan(migration.indexOf(legacyOutcome));
  });
});
