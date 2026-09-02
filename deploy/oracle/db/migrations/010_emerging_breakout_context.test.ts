import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("emerging breakout collection context migration", () => {
  it("exposes first-observation fame and prior-growth evidence", () => {
    const migration = readFileSync(
      new URL("./010_emerging_breakout_context.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("first_observed_stars");
    expect(migration).toContain("first_observation_was_trending");
    expect(migration).toContain("official_trending_episode_count");
    expect(migration).toContain("growth_comparison_captured_at");
    expect(migration).toContain("create or replace function api.collection_context()");
  });
});
