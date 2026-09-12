import { describe, expect, it, vi } from "vitest";
import { collectRemoteOnce } from "./collect-remote.ts";
import type { CollectionContext, CollectionRun } from "./remote-history.ts";
import type { GitHubRepositorySnapshot } from "./github.ts";
import type { StarHistoryCollection, StarHistoryStore } from "./star-history.ts";

const capturedAt = "2026-09-12T12:00:00.000Z";
const runId = "19000000-0000-4000-8000-000000000001";
const summary: CollectionContext = { latestCapturedAt: null, intervalMinutes: 120,
  retentionPolicy: { graceDays: 14, growthDays: 7, pushDays: 30, repositoryLimit: 1000 }, repositories: [] };
const snapshot: GitHubRepositorySnapshot = { repositoryId: "R_project", fullName: "new/project", requestedNames: ["old/project"],
  url: "https://github.com/new/project", openGraphImageUrl: "https://opengraph.githubassets.com/fixture/new/project",
  description: "fixture", language: "Rust", topics: [], observationSources: ["retained"],
  createdAt: "2026-01-01T00:00:00.000Z", pushedAt: "2026-09-12T10:00:00.000Z",
  metrics: { stars: 15100, forks: 1, watchers: 1, open_issues: 1 }, officialRanks: { daily: null, weekly: null, monthly: null } };
const previous: CollectionContext["repositories"][number] = { repositoryId: "R_project", identityStatus: "verified",
  fullName: "new/project", firstSeenAt: "2026-09-01T12:00:00.000Z", firstObservedStars: 15000,
  firstObservationWasTrending: true, officialTrendingEpisodeCount: 1, latestCapturedAt: "2026-09-11T12:00:00.000Z",
  latestPushedAt: "2026-09-11T11:00:00.000Z", latestRank: 1, latestStars: 15000,
  growthComparisonCapturedAt: null, growthComparisonStars: null,
  observations: [{ capturedAt: "2026-09-11T12:00:00.000Z", stars: 15000 }] };

function status(value: CollectionRun["status"]): CollectionRun {
  return { id: runId, status: value, startedAt: capturedAt, finishedAt: value === "running" ? null : capturedAt,
    errorMessage: value === "failed" ? "fixture" : null };
}

function fixture() {
  const historyApi = { startCollection: vi.fn().mockResolvedValue(undefined), readCollectionSummary: vi.fn().mockResolvedValue(summary),
    readEventSignals: vi.fn().mockResolvedValue([]),
    readRepositoryIdentityContext: vi.fn().mockResolvedValue({ ...summary, repositories: [previous] }),
    completeCollection: vi.fn().mockResolvedValue(undefined), readCollectionRun: vi.fn().mockResolvedValue(status("failed")),
    failCollection: vi.fn().mockResolvedValue(undefined) };
  const collectHistories = vi.fn().mockResolvedValue({ histories: [], fetched: 0, reused: 0, skipped: 1 } satisfies StarHistoryCollection);
  return { historyApi, githubToken: "fixture-only", starHistoryStore: {} as StarHistoryStore, runId,
    now: () => new Date(capturedAt), fetchRepositories: vi.fn().mockResolvedValue([snapshot]),
    readRateLimit: vi.fn().mockResolvedValue({ limit: 5000, remaining: 1000, reset_at: capturedAt }), collectHistories };
}

describe("remote collector identity and completion boundary", () => {
  it("uses identity context for growth and discovery provenance after a rename", async () => {
    const dependencies = fixture();
    await expect(collectRemoteOnce(dependencies)).resolves.toMatchObject({ runId, repositoryCount: 1 });
    expect(dependencies.historyApi.readRepositoryIdentityContext).toHaveBeenCalledWith([
      { repository_id: "R_project", full_name: "new/project", requested_names: ["old/project", "new/project"] },
    ]);
    const repository = dependencies.historyApi.completeCollection.mock.calls[0][0].repositories[0];
    expect(repository).toMatchObject({ repository_id: "R_project", identity_status: "verified", firstObservation: false,
      repository_aliases: ["old/project", "new/project"], growth: { stars_delta_24h: 100 } });
    expect(repository.trend_intelligence.classification.category).toBeNull();
  });

  it("preserves legacy facts while exposing unverified identity provenance", async () => {
    const dependencies = fixture();
    dependencies.historyApi.readRepositoryIdentityContext.mockResolvedValue({ ...summary,
      repositories: [{ ...previous, identityStatus: "legacy_unverified" }] });
    await collectRemoteOnce(dependencies);
    const repository = dependencies.historyApi.completeCollection.mock.calls[0][0].repositories[0];
    expect(repository.identity_status).toBe("legacy_unverified");
    expect(repository.trend_intelligence.classification.category).toBeNull();
    expect(repository.firstObservation).toBe(false);
  });

  it("does not fall back to old name history for a new immutable ID", async () => {
    const dependencies = fixture();
    dependencies.historyApi.readCollectionSummary.mockResolvedValue({ ...summary, repositories: [previous] });
    dependencies.historyApi.readRepositoryIdentityContext.mockResolvedValue(summary);
    dependencies.fetchRepositories.mockResolvedValue([{ ...snapshot, repositoryId: "R_reused", metrics: { ...snapshot.metrics, stars: 10 } }]);
    await collectRemoteOnce(dependencies);
    const repository = dependencies.historyApi.completeCollection.mock.calls[0][0].repositories[0];
    expect(repository.repository_id).toBe("R_reused");
    expect(repository.firstObservation).toBe(true);
    expect(repository.growth.stars_delta_24h).toBeNull();
  });

  it("recovers a committed collection after the completion response is lost", async () => {
    const dependencies = fixture();
    dependencies.historyApi.completeCollection.mockRejectedValue(new Error("response lost"));
    dependencies.historyApi.readCollectionRun.mockResolvedValue(status("completed"));
    await expect(collectRemoteOnce(dependencies)).resolves.toMatchObject({ repositoryCount: 1 });
    expect(dependencies.historyApi.failCollection).not.toHaveBeenCalled();
  });

  it("rechecks after failure recording when completion wins the database lock race", async () => {
    const dependencies = fixture();
    dependencies.historyApi.completeCollection.mockRejectedValue(new Error("response lost"));
    dependencies.historyApi.readCollectionRun.mockResolvedValueOnce(status("running")).mockResolvedValueOnce(status("completed"));
    await expect(collectRemoteOnce(dependencies)).resolves.toMatchObject({ repositoryCount: 1 });
    expect(dependencies.historyApi.failCollection).toHaveBeenCalledOnce();
    expect(dependencies.historyApi.readCollectionRun).toHaveBeenCalledTimes(2);
  });

  it("does not write failed when the completion outcome cannot be determined", async () => {
    const dependencies = fixture();
    dependencies.historyApi.completeCollection.mockRejectedValue(new Error("response lost"));
    dependencies.historyApi.readCollectionRun.mockRejectedValue(new Error("database unreachable"));
    await expect(collectRemoteOnce(dependencies)).rejects.toThrow("outcome is unknown");
    expect(dependencies.historyApi.failCollection).not.toHaveBeenCalled();
  });

  it("records a confirmed failure and preserves its original cause", async () => {
    const dependencies = fixture();
    dependencies.historyApi.completeCollection.mockRejectedValue(new Error("transaction rejected"));
    dependencies.historyApi.readCollectionRun.mockResolvedValueOnce(status("running")).mockResolvedValueOnce(status("failed"));
    await expect(collectRemoteOnce(dependencies)).rejects.toThrow("transaction rejected");
    expect(dependencies.historyApi.failCollection).toHaveBeenCalledOnce();
  });

  it("rejects mismatched identity context before saving any snapshot", async () => {
    const dependencies = fixture();
    dependencies.historyApi.readRepositoryIdentityContext.mockResolvedValue({ ...summary, repositories: [{ ...previous, repositoryId: "R_other" }] });
    await expect(collectRemoteOnce(dependencies)).rejects.toThrow("requested GitHub ID");
    expect(dependencies.historyApi.completeCollection).not.toHaveBeenCalled();
    expect(dependencies.historyApi.failCollection).toHaveBeenCalledOnce();
  });

  it("captures after the actual retained-history fetch and rejects future evidence", async () => {
    const dependencies = fixture();
    dependencies.collectHistories.mockResolvedValue({ histories: [{ full_name: snapshot.fullName,
      captured_at: "2026-09-12T12:00:01.000Z", days: [] }], fetched: 1, reused: 0, skipped: 0 });
    await expect(collectRemoteOnce(dependencies)).rejects.toThrow("later than the collection capture time");
    expect(dependencies.historyApi.completeCollection).not.toHaveBeenCalled();
  });
});
