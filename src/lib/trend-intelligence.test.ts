import { describe, expect, it } from "vitest";
import type { RankedRepository } from "./ranking";
import {
  rankTrendIntelligence,
  trendIntelligenceFor,
  type RepositoryEventSignals,
  type RepositoryStarHistory,
} from "./trend-intelligence";

const CAPTURED_AT = "2026-08-28T12:00:00.000Z";

function repository(index: number, options: {
  delta6: number | null;
  delta24: number | null;
  stars?: number;
  observedStarsPerDay?: number | null;
}): RankedRepository {
  const stars = options.stars ?? 1_000 + index * 10;
  return {
    full_name: `owner/repository-${index}`,
    url: `https://github.com/owner/repository-${index}`,
    open_graph_image_url: `https://opengraph.githubassets.com/test/owner/repository-${index}`,
    description: `Repository ${index}`,
    language: "TypeScript",
    topics: ["developer-tools"],
    observation_sources: ["github_search_pushed"],
    created_at: "2026-06-01T00:00:00.000Z",
    pushed_at: "2026-08-28T11:00:00.000Z",
    metrics: { stars, forks: 20, watchers: stars, open_issues: 5 },
    official_ranks: { daily: null, weekly: null, monthly: null },
    growth: {
      stars_delta_1h: null,
      stars_delta_6h: options.delta6,
      stars_delta_24h: options.delta24,
    },
    observedStarsPerDay: options.observedStarsPerDay
      ?? options.delta24
      ?? (options.delta6 === null ? null : options.delta6 * 4),
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

const HISTORY_ANCHOR = "2026-08-28T00:00:00.000Z";

/**
 * Completed day-ends for the 98 days ending at the anchor. `dailyGain` is the
 * gain of the most recent completed day and `priorDailyGain` the steady gain
 * of every day before it; `days` limits how much history exists.
 */
function starHistory(index: number, options: {
  dailyGain?: number;
  priorDailyGain?: number;
  days?: number;
  capturedAt?: string;
} = {}): RepositoryStarHistory {
  const dailyGain = options.dailyGain ?? 5;
  const priorDailyGain = options.priorDailyGain ?? 5;
  const days = options.days ?? 98;
  const anchor = Date.parse(HISTORY_ANCHOR);
  const finalStars = 1_000 + index * 10;
  const dayEnds = Array.from({ length: days }, (_, offset) => {
    const daysBefore = days - 1 - offset;
    const stars = daysBefore === 0
      ? finalStars
      : finalStars - dailyGain - (daysBefore - 1) * priorDailyGain;
    return {
      captured_at: new Date(anchor - daysBefore * 86_400_000).toISOString(),
      stars: Math.max(0, stars),
    };
  });
  return {
    full_name: `owner/repository-${index}`,
    captured_at: options.capturedAt ?? HISTORY_ANCHOR,
    day_ends: dayEnds,
  };
}

function starHistories(count: number): RepositoryStarHistory[] {
  return Array.from({ length: count }, (_, index) => starHistory(index));
}

describe("rankTrendIntelligence", () => {
  it("scores large and previously popular repositories like any other candidate", () => {
    const repositories = Array.from({ length: 12 }, (_, index) => repository(index, {
      delta6: 20 + index,
      delta24: 40 + index,
      stars: index === 11 ? 50_000 : undefined,
    }));
    const signals = Array.from({ length: 12 }, (_, index) => eventSignals(index, {
      h6: 30 + index,
      h24: 60 + index,
    }));

    const ranked = rankTrendIntelligence(repositories, signals, CAPTURED_AT, starHistories(12));

    expect(ranked[11].trend_intelligence.breakout.score).not.toBeNull();
    expect(ranked[11].trend_intelligence.cohort).toEqual({ key: "breakout:global", size: 12 });
    expect(ranked.every((item) => (
      item.trend_intelligence.missing_evidence.every((evidence) => !evidence.startsWith("emerging_"))
    ))).toBe(true);
  });

  it("compares the recent day with the repository's own history baseline", () => {
    const repositories = Array.from({ length: 10 }, (_, index) => repository(index, {
      delta6: 20 + index,
      delta24: 40 + index,
    }));
    const signals = Array.from({ length: 10 }, (_, index) => eventSignals(index, {
      h6: 30 + index,
      h24: 60 + index,
    }));
    const histories = starHistories(10);
    // Dormant for twelve weeks, then 40 stars in a day: the strongest self-relative growth.
    histories[0] = starHistory(0, { priorDailyGain: 0, dailyGain: 0 });
    // Younger than two completed weeks: no baseline yet.
    histories[9] = starHistory(9, { days: 10 });

    const ranked = rankTrendIntelligence(repositories, signals, CAPTURED_AT, histories);

    expect(ranked[0].trend_intelligence.breakout.components.self_relative_growth).toBe(1);
    expect(ranked[0].trend_intelligence.reasons).toContain("self_growth_acceleration");
    expect(ranked[9].trend_intelligence.breakout.components.self_relative_growth).toBeNull();
    expect(ranked[9].trend_intelligence.missing_evidence).toContain("star_history_baseline");
    expect(ranked[9].trend_intelligence.confidence).toBe("low");
    expect(ranked[1].trend_intelligence.missing_evidence).not.toContain("star_history_baseline");
  });

  it("records missing star history without excluding the repository", () => {
    const repositories = Array.from({ length: 10 }, (_, index) => repository(index, {
      delta6: 20 + index,
      delta24: 40 + index,
    }));
    const signals = Array.from({ length: 10 }, (_, index) => eventSignals(index, {
      h6: 30 + index,
      h24: 60 + index,
    }));

    const ranked = rankTrendIntelligence(
      repositories,
      signals,
      CAPTURED_AT,
      starHistories(10).slice(1),
    );

    expect(ranked[0].trend_intelligence.cohort.size).toBe(10);
    expect(ranked[0].trend_intelligence.breakout.components.self_relative_growth).toBeNull();
    expect(ranked[0].trend_intelligence.missing_evidence).toContain("star_history");
    expect(ranked[0].trend_intelligence.confidence).toBe("low");
    expect(ranked[1].trend_intelligence.missing_evidence).not.toContain("star_history");
  });

  it("rejects star history anchored after the capture time or out of order", () => {
    const repositories = [repository(0, { delta6: 10, delta24: 20 })];

    expect(() => rankTrendIntelligence(repositories, [], CAPTURED_AT, [
      starHistory(0, { capturedAt: "2026-08-28T13:00:00.000Z" }),
    ])).toThrow(RangeError);
    expect(() => rankTrendIntelligence(repositories, [], CAPTURED_AT, [{
      full_name: "owner/repository-0",
      captured_at: HISTORY_ANCHOR,
      day_ends: [
        { captured_at: "2026-08-27T00:00:00.000Z", stars: 10 },
        { captured_at: "2026-08-26T00:00:00.000Z", stars: 5 },
      ],
    }])).toThrow(RangeError);
    expect(() => rankTrendIntelligence(repositories, [], CAPTURED_AT, [
      starHistory(0),
      starHistory(0),
    ])).toThrow("Duplicate star history");
  });

  it("limits six-hour breakout candidates to the top ten percent", () => {
    const repositories = Array.from({ length: 20 }, (_, index) => repository(index, {
      delta6: 5 + index,
      delta24: null,
    }));
    const histories = Array.from({ length: 20 }, (_, index) => starHistory(index, { days: 8 }));

    const ranked = rankTrendIntelligence(repositories, [], CAPTURED_AT, histories);
    const surfaced = ranked.filter((item) => item.trend_intelligence.breakout.score !== null);

    expect(ranked[0].trend_intelligence.star_evidence_window_hours).toBe(6);
    expect(surfaced).toHaveLength(2);
    expect(surfaced.map((item) => item.full_name)).toEqual([
      "owner/repository-18",
      "owner/repository-19",
    ]);
    expect(surfaced.every((item) => item.trend_intelligence.confidence === "low")).toBe(true);
    expect(ranked[0].trend_intelligence.missing_evidence).toContain("star_window_24h");
    expect(ranked[0].trend_intelligence.missing_evidence).toContain("star_history_baseline");
    expect(ranked[0].trend_intelligence.missing_evidence).toContain("github_events");
  });

  it("uses observed velocity while fixed growth windows recover", () => {
    const repositories = Array.from({ length: 20 }, (_, index) => repository(index, {
      delta6: null,
      delta24: null,
      observedStarsPerDay: 10 + index,
    }));

    const ranked = rankTrendIntelligence(repositories, [], CAPTURED_AT, []);
    const surfaced = ranked.filter((item) => item.trend_intelligence.breakout.score !== null);

    expect(surfaced).toHaveLength(2);
    expect(surfaced.map((item) => item.full_name)).toEqual([
      "owner/repository-18",
      "owner/repository-19",
    ]);
    expect(surfaced.every((item) => item.trend_intelligence.star_evidence_window_hours === null)).toBe(true);
    expect(surfaced.every((item) => item.trend_intelligence.confidence === "low")).toBe(true);
    expect(ranked[0].trend_intelligence.missing_evidence).toContain("star_growth_window");
  });

  it("uses GitHub's latest completed day before short observed velocity", () => {
    const repositories = Array.from({ length: 20 }, (_, index) => repository(index, {
      delta6: null,
      delta24: null,
      observedStarsPerDay: index === 0 ? 500 : null,
    }));
    const histories = Array.from({ length: 20 }, (_, index) => starHistory(index, {
      dailyGain: 10 + index,
    }));

    const ranked = rankTrendIntelligence(repositories, [], CAPTURED_AT, histories);
    const surfaced = ranked.filter((item) => item.trend_intelligence.breakout.score !== null);

    expect(surfaced.map((item) => item.full_name)).toEqual([
      "owner/repository-18",
      "owner/repository-19",
    ]);
    expect(ranked[0].trend_intelligence.missing_evidence).toContain("star_window_observed");
    expect(ranked[0].trend_intelligence.missing_evidence).not.toContain("star_growth_window");
    expect(ranked[0].trend_intelligence.breakout.components.self_relative_growth).not.toBeNull();
  });

  it("ignores a completed history day that is too old to describe the last 24 hours", () => {
    const repositories = Array.from({ length: 3 }, (_, index) => repository(index, {
      delta6: null,
      delta24: null,
      observedStarsPerDay: null,
    }));
    const staleAnchor = "2026-08-24T00:00:00.000Z";
    const histories = Array.from({ length: 3 }, (_, index) => {
      const history = starHistory(index, { dailyGain: 50 });
      return {
        ...history,
        captured_at: staleAnchor,
        day_ends: history.day_ends.filter((point) => point.captured_at <= staleAnchor),
      };
    });

    const ranked = rankTrendIntelligence(repositories, [], CAPTURED_AT, histories);

    expect(ranked.every((item) => item.trend_intelligence.breakout.score === null)).toBe(true);
    expect(ranked[0].trend_intelligence.missing_evidence).toContain("star_growth_window");
  });

  it("surfaces every mature breakout candidate above the spark threshold", () => {
    const repositories = Array.from({ length: 20 }, (_, index) => repository(index, {
      delta6: 10 + index * 3,
      delta24: 20 + index * 5,
    }));

    const ranked = rankTrendIntelligence(
      repositories,
      [],
      CAPTURED_AT,
      starHistories(20),
    );
    const surfaced = ranked.filter((item) => item.trend_intelligence.breakout.score !== null);

    expect(surfaced.length).toBeGreaterThan(2);
    expect(surfaced.every((item) => (
      (item.trend_intelligence.breakout.score ?? 0) >= 70
    ))).toBe(true);
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

    const ranked = rankTrendIntelligence(repositories, signals, CAPTURED_AT, starHistories(10));
    const breakout = ranked[9].trend_intelligence;

    expect(ranked.map((item) => item.rank)).toEqual(repositories.map((item) => item.rank));
    expect(breakout.breakout.score).toBeGreaterThan(90);
    expect(breakout.current_heat.score).toBeGreaterThan(85);
    expect(breakout.phase).toBe("breakout");
    expect(breakout.reasons).toContain("peer_growth_outlier");
    expect(breakout.cohort.size).toBe(10);
  });

  it("keeps star-only breakout evidence explicit when GitHub events are missing", () => {
    const repositories = Array.from({ length: 10 }, (_, index) => repository(index, {
      delta6: 5 + index,
      delta24: 20 + index,
    }));

    const ranked = rankTrendIntelligence(repositories, [], CAPTURED_AT, starHistories(10));

    expect(ranked[9].trend_intelligence.breakout.score).not.toBeNull();
    expect(ranked[0].trend_intelligence.current_heat.score).toBeNull();
    expect(ranked[9].trend_intelligence.phase).not.toBe("insufficient_data");
    expect(ranked[0].trend_intelligence.confidence).toBe("low");
    expect(ranked[0].trend_intelligence.missing_evidence).toContain("github_events");
  });

  it("does not label event-only repositories as breakout without star growth", () => {
    const repositories = Array.from({ length: 10 }, (_, index) => repository(index, {
      delta6: 0,
      delta24: 0,
      stars: index,
    }));
    const signals = Array.from({ length: 10 }, (_, index) => eventSignals(index, {
      h6: 100 + index * 10,
      h24: 200 + index * 20,
    }));

    const ranked = rankTrendIntelligence(repositories, signals, CAPTURED_AT, starHistories(10));

    expect(ranked.every((item) => item.trend_intelligence.breakout.score === null)).toBe(true);
    expect(ranked.every((item) => item.trend_intelligence.current_heat.score === null)).toBe(true);
    expect(ranked.every((item) => item.trend_intelligence.phase === "insufficient_data")).toBe(true);
  });

  it("writes the revised score version while accepting historical v2 snapshots", () => {
    const ranked = rankTrendIntelligence(
      Array.from({ length: 10 }, (_, index) => repository(index, { delta6: 5, delta24: 20 })),
      Array.from({ length: 10 }, (_, index) => eventSignals(index, { h6: 10, h24: 30 })),
      CAPTURED_AT,
      starHistories(10),
    );

    expect(ranked[0].trend_intelligence.score_version).toBe("trend-intelligence-v6-shadow");
    const historical = structuredClone(ranked[0]);
    historical.trend_intelligence.score_version = "trend-intelligence-v2-shadow";
    expect(trendIntelligenceFor(historical)?.score_version).toBe("trend-intelligence-v2-shadow");
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

    const ranked = rankTrendIntelligence(repositories, signals, CAPTURED_AT, starHistories(10));

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
    const histories = starHistories(10);
    const repositoriesBefore = structuredClone(repositories);
    const signalsBefore = structuredClone(signals);
    const historiesBefore = structuredClone(histories);

    const ranked = rankTrendIntelligence(repositories, signals, CAPTURED_AT, histories);

    expect(repositories).toEqual(repositoriesBefore);
    expect(signals).toEqual(signalsBefore);
    expect(histories).toEqual(historiesBefore);
    expect(ranked[0].observation_sources).not.toBe(repositories[0].observation_sources);
  });
});
