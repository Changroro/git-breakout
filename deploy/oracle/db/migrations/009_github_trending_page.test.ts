import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GitHub Trending ranking migration", () => {
  it("keeps periods separate and orders official ranks ascending", () => {
    const migration = readFileSync(
      new URL("./009_github_trending_page.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("p_period text");
    expect(migration).toContain("p_period is null or p_period not in ('daily', 'weekly', 'monthly')");
    expect(migration).toContain("array['official_ranks', p_period]");
    expect(migration).toContain("case when p_view = 'github'");
  });
});
