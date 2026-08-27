import { describe, expect, it } from "vitest";
import { parseStarHistoryLookup, parseStarHistoryRepository } from "./star-history";

export const starHistoryApiResponse = {
  repo: {
    name: "apache/maka",
    owner: "apache",
    owner_type: "Organization",
    stars_total: 3082,
    description: "Local-first AI agent workspace",
    language: "TypeScript",
    topics: ["ai", "local-first"],
    license: "Apache-2.0",
    homepage: null,
    forks_count: 313,
    contributors_count: 83,
    open_issues_count: 271,
    created_at: "2026-05-27T15:46:05.000Z",
    archived: false,
    size: 81362,
    weekly_percentiles: {
      stars: 4,
      new_stars: 86,
      pushes: 99,
      contributors: 57,
      issues_closed: 97,
      forks: 10,
    },
    weekly_activity: {
      new_stars: 1,
      pushes: 28,
      issues_closed: 1,
    },
    milestones: [],
  },
};

describe("Star History response parsing", () => {
  it("parses repository statistics used by the activity card", () => {
    expect(parseStarHistoryRepository(starHistoryApiResponse)).toMatchObject({
      name: "apache/maka",
      contributors_count: 83,
      weekly_percentiles: { new_stars: 86, pushes: 99 },
      weekly_activity: { new_stars: 1, pushes: 28, issues_closed: 1 },
    });
  });

  it("rejects incomplete percentile data", () => {
    const malformed = structuredClone(starHistoryApiResponse);
    delete (malformed.repo.weekly_percentiles as Partial<typeof malformed.repo.weekly_percentiles>).forks;
    expect(() => parseStarHistoryRepository(malformed)).toThrow(
      "repo.weekly_percentiles.forks",
    );
  });

  it("parses available and unavailable lookup results", () => {
    expect(parseStarHistoryLookup({
      status: "available",
      checked_at: "2026-08-26T03:00:00.000Z",
      repo: starHistoryApiResponse.repo,
    }).status).toBe("available");
    expect(parseStarHistoryLookup({
      status: "unavailable",
      checked_at: "2026-08-26T03:00:00.000Z",
      repo: null,
    })).toEqual({
      status: "unavailable",
      checked_at: "2026-08-26T03:00:00.000Z",
      repo: null,
    });
  });
});
