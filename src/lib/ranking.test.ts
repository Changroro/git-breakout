import { describe, expect, it } from "vitest";
import { rankRepositories, type RepositoryCandidate } from "./ranking";

const capturedAt = "2026-08-25T00:00:00.000Z";

function candidate(overrides: Partial<RepositoryCandidate> = {}): RepositoryCandidate {
  return {
    full_name: "example/radar",
    url: "https://github.com/example/radar",
    open_graph_image_url: "https://opengraph.githubassets.com/test/example/radar",
    description: "AI trend radar",
    language: "TypeScript",
    topics: ["ai"],
    observation_sources: ["official_daily", "github_search_pushed"],
    created_at: "2026-08-15T00:00:00.000Z",
    pushed_at: "2026-08-24T00:00:00.000Z",
    metrics: {
      stars: 100,
      forks: 10,
      watchers: 100,
      open_issues: 2,
    },
    official_ranks: {
      daily: 3,
      weekly: null,
      monthly: 12,
    },
    growth: {
      stars_delta_1h: 5,
      stars_delta_6h: 20,
      stars_delta_24h: 40,
    },
    observedStarsPerDay: 40,
    firstObservation: false,
    ...overrides,
  };
}

describe("rankRepositories", () => {
  it("reproduces the baseline-v1 weighted score", () => {
    const [ranked] = rankRepositories([candidate()], capturedAt);
    const expected =
      Math.log1p(40) * 55 +
      Math.log1p(10) * 28 +
      Math.log1p(100) * 5 +
      Math.log1p(10) * 2 +
      Math.log1p(2) * 0.5 +
      13;

    expect(ranked.rank).toBe(1);
    expect(ranked.momentum.score).toBeCloseTo(expected, 4);
    expect(ranked.momentum.score_version).toBe("baseline-v1");
    expect(ranked.momentum.components).toMatchObject({
      observed_growth_score: expect.closeTo(Math.log1p(40) * 55, 4),
      lifetime_velocity_score: expect.closeTo(Math.log1p(10) * 28, 4),
      size_score: expect.closeTo(Math.log1p(100) * 5, 4),
      first_observation_score: 0,
      observation_count: 3,
      metric_completeness: 1,
    });
    expect(ranked.momentum.confidence).toBe("high");
  });

  it("preserves unavailable growth windows without estimating them", () => {
    const input = candidate({
      growth: {
        stars_delta_1h: 4,
        stars_delta_6h: null,
        stars_delta_24h: null,
      },
      metrics: {
        stars: 100,
        forks: 10,
        watchers: null,
        open_issues: 2,
      },
    });

    const [ranked] = rankRepositories([input], capturedAt);

    expect(ranked.growth).toEqual(input.growth);
    expect(ranked.momentum.components.observation_count).toBe(1);
    expect(ranked.momentum.components.metric_completeness).toBe(0.75);
    expect(ranked.momentum.confidence).toBe("medium");
  });

  it("scores a first observation only with the explicit first-observation bonus", () => {
    const input = candidate({
      growth: {
        stars_delta_1h: null,
        stars_delta_6h: null,
        stars_delta_24h: null,
      },
      observedStarsPerDay: null,
      firstObservation: true,
    });

    const [ranked] = rankRepositories([input], capturedAt);

    expect(ranked.momentum.components.observed_growth_score).toBeNull();
    expect(ranked.momentum.components.first_observation_score).toBe(12);
    expect(ranked.momentum.components.observation_count).toBe(0);
    expect(ranked.momentum.confidence).toBe("low");
  });

  it("rejects a missing observed velocity after the first observation", () => {
    expect(() =>
      rankRepositories([candidate({ observedStarsPerDay: null })], capturedAt),
    ).toThrow("observedStarsPerDay is required after the first observation");
  });

  it("rejects a non-HTTPS Open Graph image", () => {
    expect(() => rankRepositories([
      candidate({ open_graph_image_url: "http://example.com/card.png" }),
    ], capturedAt)).toThrow("open_graph_image_url must be a valid HTTPS URL");
  });

  it("rejects missing and invalid observation sources", () => {
    const missing = candidate() as Partial<RepositoryCandidate>;
    delete missing.observation_sources;
    expect(() => rankRepositories([
      missing as RepositoryCandidate,
    ], capturedAt)).toThrow("observation_sources must be a non-empty array");
    expect(() => rankRepositories([
      candidate({ observation_sources: [] }),
    ], capturedAt)).toThrow("observation_sources must be a non-empty array");
    expect(() => rankRepositories([
      candidate({ observation_sources: ["unknown"] as never }),
    ], capturedAt)).toThrow("observation_sources contains an invalid observation source");
  });

  it("normalizes observation sources in deterministic order", () => {
    const [ranked] = rankRepositories([
      candidate({
        observation_sources: ["retained", "official_daily", "retained", "gh_archive"],
      }),
    ], capturedAt);

    expect(ranked.observation_sources).toEqual(["official_daily", "gh_archive", "retained"]);
  });

  it("breaks equal scores by full_name", () => {
    const first = candidate({ full_name: "zeta/radar", url: "https://github.com/zeta/radar" });
    const second = candidate({ full_name: "alpha/radar", url: "https://github.com/alpha/radar" });

    expect(rankRepositories([first, second], capturedAt).map((item) => item.full_name)).toEqual([
      "alpha/radar",
      "zeta/radar",
    ]);
  });

  it("does not mutate candidates or their nested values", () => {
    const input = candidate();
    const snapshot = structuredClone(input);

    const [ranked] = rankRepositories([input], capturedAt);

    expect(input).toEqual(snapshot);
    expect(ranked).not.toBe(input);
    expect(ranked.metrics).not.toBe(input.metrics);
    expect(ranked.growth).not.toBe(input.growth);
    expect(ranked.topics).not.toBe(input.topics);
    expect(ranked.observation_sources).not.toBe(input.observation_sources);
  });

  it("returns the same ranking for repeated calls at the same captured time", () => {
    const inputs = [
      candidate({ full_name: "beta/two", observedStarsPerDay: 8 }),
      candidate({ full_name: "alpha/one", observedStarsPerDay: 12 }),
    ];

    expect(rankRepositories(inputs, capturedAt)).toEqual(rankRepositories(inputs, capturedAt));
  });
});
