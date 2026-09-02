import { describe, expect, it } from "vitest";
import {
  buildRepositoryFilterOptions,
  buildRankingHref,
  filterRepositories,
  parseGitHubTrendingPeriod,
  parseRankingView,
  parseRepositoryFilters,
} from "./repository-filters";

const repositories = [
  { full_name: "alpha/one", language: "TypeScript", topics: ["ai", "agents"] },
  { full_name: "beta/two", language: "Python", topics: ["AI", "data"] },
  { full_name: "gamma/three", language: "TypeScript", topics: ["web", "agents", "agents"] },
  { full_name: "delta/four", language: null, topics: [] },
];

describe("repository filters", () => {
  it("counts language and topic options without duplicate repository topics", () => {
    expect(buildRepositoryFilterOptions(repositories)).toEqual({
      languages: [
        { value: "typescript", label: "TypeScript", count: 2 },
        { value: "python", label: "Python", count: 1 },
      ],
      topics: [
        { value: "agents", label: "agents", count: 2 },
        { value: "ai", label: "ai", count: 2 },
        { value: "data", label: "data", count: 1 },
        { value: "web", label: "web", count: 1 },
      ],
    });
  });

  it("combines language and topic filters", () => {
    expect(filterRepositories(repositories, {
      language: "typescript",
      topic: "agents",
    }).map((repository) => repository.full_name)).toEqual([
      "alpha/one",
      "gamma/three",
    ]);
  });

  it("reads normalized filters from the URL", () => {
    expect(parseRepositoryFilters("?language=TypeScript&topic=AI")).toEqual({
      language: "typescript",
      topic: "ai",
    });
  });

  it("builds a shareable ranking URL and omits inactive filters", () => {
    expect(buildRankingHref(3, "snapshot-1", {
      language: "typescript",
      topic: null,
    })).toBe("?page=3&snapshot=snapshot-1&language=typescript");
    expect(buildRankingHref(2, "snapshot-1", {
      language: null,
      topic: null,
    }, "momentum")).toBe("?page=2&snapshot=snapshot-1&view=momentum");
    expect(buildRankingHref(1, "snapshot-1", {
      language: null,
      topic: null,
    }, "github", "weekly")).toBe("?page=1&snapshot=snapshot-1&view=github&period=weekly");
  });

  it("parses an explicit ranking view", () => {
    expect(parseRankingView("?view=current")).toBe("current");
    expect(parseRankingView("?view=breakout")).toBe("breakout");
    expect(parseRankingView("?view=github")).toBe("github");
    expect(parseRankingView("?page=2")).toBe("breakout");
    expect(() => parseRankingView("?view=unknown")).toThrow("Unknown ranking view");
  });

  it("defaults GitHub Trending to Daily and validates explicit periods", () => {
    expect(parseGitHubTrendingPeriod("?view=github")).toBe("daily");
    expect(parseGitHubTrendingPeriod("?view=github&period=weekly")).toBe("weekly");
    expect(parseGitHubTrendingPeriod("?view=github&period=monthly")).toBe("monthly");
    expect(() => parseGitHubTrendingPeriod("?view=github&period=yearly")).toThrow(
      "Unknown GitHub Trending period",
    );
  });
});
