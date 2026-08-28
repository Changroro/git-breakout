import { describe, expect, it } from "vitest";
import {
  buildRepositoryFilterOptions,
  buildRankingHref,
  filterRepositories,
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
    }, "breakout")).toBe("?page=2&snapshot=snapshot-1&view=breakout");
  });

  it("parses an explicit ranking view", () => {
    expect(parseRankingView("?view=current")).toBe("current");
    expect(parseRankingView("?view=breakout")).toBe("breakout");
    expect(parseRankingView("?page=2")).toBe("momentum");
    expect(() => parseRankingView("?view=unknown")).toThrow("Unknown ranking view");
  });
});
