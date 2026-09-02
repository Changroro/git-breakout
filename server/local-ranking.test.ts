import { describe, expect, it } from "vitest";
import { sampleRepositories } from "../src/data/repositories.ts";
import { rankRepositories } from "../src/lib/ranking.ts";
import type { RankingSnapshot } from "../src/lib/history.ts";
import { buildLocalRankingPage, buildLocalRepositorySearch } from "./local-ranking.ts";

function snapshot(): RankingSnapshot {
  return {
    id: "snapshot",
    captured_at: "2026-08-25T00:00:00.000Z",
    source: "test",
    repositories: rankRepositories(sampleRepositories, "2026-08-25T00:00:00.000Z"),
  };
}

describe("local ranking API", () => {
  it("filters, clamps, and paginates a snapshot", () => {
    const result = buildLocalRankingPage({
      snapshot: snapshot(),
      page: 999,
      pageSize: 3,
      filters: { language: "typescript", topic: null },
      view: "momentum",
      period: null,
    });

    expect(result.page).toBe(Math.ceil(result.matching_count / 3));
    expect(result.repositories.length).toBeLessThanOrEqual(3);
    expect(result.repositories.every((repository) => repository.language === "TypeScript")).toBe(true);
    expect(result.track_record).toMatchObject({ verified_count: 0, evidence_started_at: null });
    expect(result.repositories.every(
      (repository) => repository.discovery_evidence.outcome === "legacy",
    )).toBe(true);
  });

  it("sorts GitHub Trending by the selected official period", () => {
    const result = buildLocalRankingPage({
      snapshot: snapshot(),
      page: 1,
      pageSize: 3,
      filters: { language: null, topic: null },
      view: "github",
      period: "weekly",
    });

    expect(result.matching_count).toBe(20);
    expect(result.repositories.map((repository) => repository.full_name)).toEqual([
      "anthropics/claude-code",
      "modelcontextprotocol/servers",
      "openai/codex",
    ]);
  });

  it("returns bounded repository search results", () => {
    const result = buildLocalRepositorySearch(snapshot(), "ai", 2);

    expect(result.repositories.length).toBeLessThanOrEqual(2);
    expect(result.total_count).toBeGreaterThanOrEqual(result.repositories.length);
  });
});
