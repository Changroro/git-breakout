import { describe, expect, it } from "vitest";
import type { RankedRepository } from "./ranking";
import {
  rankTrendIntelligence,
  type RepositoryEventSignals,
} from "./trend-intelligence";

const CAPTURED_AT = "2026-08-28T12:00:00.000Z";

function repository(index: number, options: {
  delta6: number;
  delta24: number | null;
  stars?: number;
}): RankedRepository {
  const stars = options.stars ?? 1_000 + index * 10;
  return {
    full_name: `owner/repository-${index}`,
    url: `https://github.com/owner/repository-${index}`,
    open_graph_image_url: `https://opengraph.githubassets.com/test/owner/repository-${index}`,
    description: `Repository ${index}`,
    language: "TypeScript",
    topics: ["developer-tools"],
    created_at: "2026-06-01T00:00:00.000Z",
    pushed_at: "2026-08-28T11:00:00.000Z",
    metrics: { stars, forks: 20, watchers: stars, open_issues: 5 },
    official_ranks: { daily: null, weekly: null, monthly: null },
    growth: {
      stars_delta_1h: null,
      stars_delta_6h: options.delta6,
      stars_delta_24h: options.delta24,
    },
    observedStarsPerDay: options.delta24 ?? options.delta6 * 4,
    firstObservation: false,
    rank: index + 1,
    momentum: {
      score: 100 - index,
      score_version: "baseline-v1",
      confidence: "high",
      reasons: [],
      components: {
        observed_growth_score: 1,
        lifetime_velocity_score: 1,
        activity_score: 1,
        official_signal_score: 0,
        size_score: 1,
        forks_score: 1,
        open_issues_score: 1,
        recent_push_score: 1,
        first_observation_score: 0,
        observation_count: 2,
        metric_completeness: 1,
      },
    },
  };
}

function eventSignals(index: number, actors: {
  h6: number;
  h24: number;
  h72?: number;
  coverage?: RepositoryEventSignals["coverage"];
}): RepositoryEventSignals {
  return {
    full_name: `owner/repository-${index}`,
    captured_at: "2026-08-28T11:00:00.000Z",
    coverage: actors.coverage ?? { h1: true, h6: true, h24: true, h72: true },
    windows: {
      h1: {
        watches: Math.floor(actors.h6 / 6),
        forks: 0,
        pull_requests: 0,
        issues: 0,
        issue_comments: 0,
        pushes: 1,
        releases: 0,
        unique_actors: Math.floor(actors.h6 / 6) + 1,
      },
      h6: {
        watches: actors.h6,
        forks: Math.floor(actors.h6 / 10),
        pull_requests: Math.floor(actors.h6 / 12),
        issues: 1,
        issue_comments: 1,
        pushes: 3,
        releases: 0,
        unique_actors: actors.h6,
      },
      h24: {
        watches: actors.h24,
        forks: Math.floor(actors.h24 / 10),
        pull_requests: Math.floor(actors.h24 / 12),
        issues: 2,
        issue_comments: 2,
        pushes: 8,
        releases: 1,
        unique_actors: actors.h24,
      },
      h72: {
        watches: actors.h72 ?? actors.h24 * 2,
        forks: Math.floor((actors.h72 ?? actors.h24 * 2) / 10),
        pull_requests: Math.floor((actors.h72 ?? actors.h24 * 2) / 12),
        issues: 4,
        issue_comments: 4,
        pushes: 16,
        releases: 1,
        unique_actors: actors.h72 ?? actors.h24 * 2,
      },
    },
  };
}

describe("rankTrendIntelligence", () => {
  it("scores an explicit six-hour warm-up window before 24-hour history exists", () => {
    const repositories = Array.from({ length: 10 }, (_, index) => repository(index, {
      delta6: 5 + index,
      delta24: null,
    }));
    const signals = Array.from({ length: 10 }, (_, index) => eventSignals(index, {
      h6: 10 + index,
      h24: 30 + index,
      coverage: { h1: true, h6: false, h24: false, h72: false },
    }));

    const ranked = rankTrendIntelligence(repositories, signals, CAPTURED_AT);

    expect(ranked[0].trend_intelligence.star_evidence_window_hours).toBe(6);
    expect(ranked[0].trend_intelligence.event_evidence_window_hours).toBe(1);
    expect(ranked[0].trend_intelligence.current_heat.score).not.toBeNull();
    expect(ranked[0].trend_intelligence.breakout.score).not.toBeNull();
    expect(ranked[0].trend_intelligence.breakout.components.star_acceleration).toBeNull();
    expect(ranked[0].trend_intelligence.breakout.components.actor_acceleration).toBeNull();
    expect(ranked[0].trend_intelligence.missing_evidence).toContain("star_window_24h");
    expect(ranked[0].trend_intelligence.missing_evidence).toContain("event_window_24h");
  });

  it("surfaces a peer-cohort breakout without changing baseline rank", () => {
    const repositories = Array.from({ length: 10 }, (_, index) => repository(index, {
      delta6: index === 9 ? 80 : 2 + index,
      delta24: index === 9 ? 100 : 20 + index,
    }));
    const signals = Array.from({ length: 10 }, (_, index) => eventSignals(index, {
      h6: index === 9 ? 90 : 8 + index,
      h24: index === 9 ? 120 : 30 + index,
    }));

    const ranked = rankTrendIntelligence(repositories, signals, CAPTURED_AT);
    const breakout = ranked[9].trend_intelligence;

    expect(ranked.map((item) => item.rank)).toEqual(repositories.map((item) => item.rank));
    expect(breakout.breakout.score).toBeGreaterThan(90);
    expect(breakout.current_heat.score).toBeGreaterThan(85);
    expect(breakout.phase).toBe("breakout");
    expect(breakout.reasons).toContain("peer_growth_outlier");
    expect(breakout.cohort.size).toBe(10);
  });

  it("marks missing event evidence unavailable instead of inventing a score", () => {
    const repositories = Array.from({ length: 10 }, (_, index) => repository(index, {
      delta6: 5 + index,
      delta24: 20 + index,
    }));

    const ranked = rankTrendIntelligence(repositories, [], CAPTURED_AT);

    expect(ranked[0].trend_intelligence.breakout.score).toBeNull();
    expect(ranked[0].trend_intelligence.current_heat.score).toBeNull();
    expect(ranked[0].trend_intelligence.phase).toBe("insufficient_data");
    expect(ranked[0].trend_intelligence.confidence).toBe("low");
    expect(ranked[0].trend_intelligence.missing_evidence).toContain("github_events");
  });

  it("rejects stale event evidence", () => {
    const repositories = Array.from({ length: 10 }, (_, index) => repository(index, {
      delta6: 5 + index,
      delta24: 20 + index,
    }));
    const signals = Array.from({ length: 10 }, (_, index) => ({
      ...eventSignals(index, { h6: 20, h24: 50 }),
      captured_at: "2026-08-28T06:00:00.000Z",
    }));

    const ranked = rankTrendIntelligence(repositories, signals, CAPTURED_AT);

    expect(ranked[0].trend_intelligence.current_heat.score).toBeNull();
    expect(ranked[0].trend_intelligence.missing_evidence).toContain("fresh_github_events");
  });

  it("does not mutate repositories or event signals", () => {
    const repositories = Array.from({ length: 10 }, (_, index) => repository(index, {
      delta6: 5 + index,
      delta24: 20 + index,
    }));
    const signals = Array.from({ length: 10 }, (_, index) => eventSignals(index, {
      h6: 10 + index,
      h24: 30 + index,
    }));
    const repositoriesBefore = structuredClone(repositories);
    const signalsBefore = structuredClone(signals);

    rankTrendIntelligence(repositories, signals, CAPTURED_AT);

    expect(repositories).toEqual(repositoriesBefore);
    expect(signals).toEqual(signalsBefore);
  });
});
