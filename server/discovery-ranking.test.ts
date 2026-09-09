import { describe, expect, it } from "vitest";
import { sampleRepositories } from "../src/data/repositories.ts";
import { rankRepositories } from "../src/lib/ranking.ts";
import { rankTrendIntelligence, type RepositoryStarHistory } from "../src/lib/trend-intelligence.ts";
import { buildLocalRankingPage } from "./local-ranking.ts";
import { parseRankingPageResponse } from "../src/lib/history.ts";

const capturedAt = "2026-09-09T12:00:00.000Z";
const candidates = Array.from({ length: 8 }, (_, index) => ({
  ...sampleRepositories[index], full_name: `example/repository-${index}`, observation_sources: ["github_search_created" as const],
  official_ranks: { daily: null, weekly: null, monthly: null },
  metrics: { stars: 1000, watchers: 10, open_issues: 2, forks: 10 },
  growth: { stars_delta_1h: null, stars_delta_6h: 10 + (index % 4) * 20, stars_delta_24h: 20 + (index % 4) * 30 },
  observedStarsPerDay: 20 + (index % 4) * 30, firstObservation: false,
}));
const origins = candidates.map(r => ({ full_name: r.full_name, first_observed_at: "2026-08-01T00:00:00.000Z",
  first_observed_stars: 100, first_observation_was_trending: false, official_trending_episode_count: 0 }));
const histories: RepositoryStarHistory[] = candidates.map((r, i) => ({ full_name: r.full_name, captured_at: capturedAt,
  days: Array.from({ length: 29 }, (_, day) => ({
    start: new Date(Date.parse("2026-09-09T00:00:00.000Z") - (29-day)*86_400_000).toISOString(),
    end: new Date(Date.parse("2026-09-09T00:00:00.000Z") - (28-day)*86_400_000).toISOString(),
    retained_stars_added: i < 4 ? 5 : day === 28 ? 30+i : day >= 21 ? 2 : 20,
  })),
}));

describe("discovery and resurgence boards", () => {
  it("scores independent cohorts without changing baseline order", () => {
    const all = rankTrendIntelligence(rankRepositories(candidates, capturedAt), [], capturedAt, histories, origins);
    const discoveryOnly = rankTrendIntelligence(rankRepositories(candidates.slice(0,4), capturedAt), [], capturedAt, histories.slice(0,4), origins.slice(0,4));
    expect(all.map(r=>r.rank)).toEqual(rankRepositories(candidates,capturedAt).map(r=>r.rank));
    for (const r of discoveryOnly) {
      const full = all.find(item=>item.full_name===r.full_name)!;
      expect(full.trend_intelligence.breakout).toEqual(r.trend_intelligence.breakout);
      expect(full.trend_intelligence.cohort).toEqual({ key: "discovery", size: 4 });
    }
    const snapshot = { id: "split", captured_at: capturedAt, source: "test", repositories: all };
    const read = (view: "breakout" | "resurgence") => parseRankingPageResponse(buildLocalRankingPage({ snapshot, view, page: 999,
      pageSize: 1, filters: { language: null, topic: null }, period: null }));
    const discoveries = read("breakout"), returns = read("resurgence");
    expect(discoveries.matching_count).toBeGreaterThan(0);
    expect(returns.matching_count).toBeGreaterThan(0);
    expect(discoveries.classification_available).toBe(true);
    expect(returns.classification_available).toBe(true);
    expect(discoveries.repositories.every(r=>Number(r.full_name.split('-').at(-1))<4)).toBe(true);
    expect(returns.repositories.every(r=>Number(r.full_name.split('-').at(-1))>=4)).toBe(true);
    expect(all.every(r=>r.trend_intelligence.breakout.score===null || r.trend_intelligence.resurgence?.score===null)).toBe(true);
  });

  it("preserves original mixed breakout history and reports classification as unavailable", () => {
    const all = rankTrendIntelligence(rankRepositories(candidates, capturedAt), [], capturedAt, histories, origins).map(r=>({
      ...r, trend_intelligence: { ...r.trend_intelligence, score_version: "trend-intelligence-v6-shadow" as const, resurgence: undefined, classification: undefined },
    }));
    const result = buildLocalRankingPage({ snapshot: { id: "old", captured_at: capturedAt, source: "test", repositories: all },
      view: "resurgence", page: 1, pageSize: 10, filters: { language: null, topic: null }, period: null });
    expect(result.classification_available).toBe(false);
    expect(result.repositories).toHaveLength(0);
  });
});
