import { describe, expect, it } from "vitest";
import {
  selectRetainedRepositoryNames,
  type RepositoryRetentionCandidate,
  type RetentionPolicy,
} from "./retention.ts";

const policy: RetentionPolicy = {
  graceDays: 14,
  growthDays: 7,
  pushDays: 30,
  repositoryLimit: 1_000,
};

function candidate(
  fullName: string,
  overrides: Partial<RepositoryRetentionCandidate> = {},
): RepositoryRetentionCandidate {
  return {
    fullName,
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    latestCapturedAt: "2026-08-27T00:00:00.000Z",
    latestPushedAt: "2026-07-01T00:00:00.000Z",
    latestRank: 1,
    latestStars: 10,
    growthComparisonStars: 10,
    ...overrides,
  };
}

describe("selectRetainedRepositoryNames", () => {
  it("keeps repositories in grace, with growth, or with a recent push", () => {
    expect(selectRetainedRepositoryNames([
      candidate("old/inactive"),
      candidate("new/grace", { firstSeenAt: "2026-08-20T00:00:00.000Z", latestRank: 4 }),
      candidate("old/growing", { latestStars: 11, latestRank: 3 }),
      candidate("old/pushed", { latestPushedAt: "2026-08-10T00:00:00.000Z", latestRank: 2 }),
    ], "2026-08-27T00:00:00.000Z", policy)).toEqual([
      "old/pushed",
      "old/growing",
      "new/grace",
    ]);
  });

  it("caps carry-over repositories by their latest momentum rank", () => {
    const limitedPolicy = { ...policy, repositoryLimit: 2 };
    expect(selectRetainedRepositoryNames([
      candidate("rank/three", { latestStars: 11, latestRank: 3 }),
      candidate("rank/one", { latestStars: 11, latestRank: 1 }),
      candidate("rank/two", { latestStars: 11, latestRank: 2 }),
    ], "2026-08-27T00:00:00.000Z", limitedPolicy)).toEqual([
      "rank/one",
      "rank/two",
    ]);
  });

  it("rejects duplicate repositories and invalid policy values", () => {
    expect(() => selectRetainedRepositoryNames([
      candidate("alpha/one"),
      candidate("ALPHA/ONE"),
    ], "2026-08-27T00:00:00.000Z", policy)).toThrow("duplicate");
    expect(() => selectRetainedRepositoryNames(
      [],
      "2026-08-27T00:00:00.000Z",
      { ...policy, repositoryLimit: 0 },
    )).toThrow("positive integer");
  });
});
