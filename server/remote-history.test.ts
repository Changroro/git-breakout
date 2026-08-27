import { describe, expect, it, vi } from "vitest";
import {
  parseCollectionContext,
  parseSnapshotTimeline,
  RemoteHistoryApi,
} from "./remote-history.ts";

describe("parseCollectionContext", () => {
  it("parses persisted repository observations", () => {
    expect(parseCollectionContext({
      latest_captured_at: "2026-08-26T08:00:00.000Z",
      interval_minutes: 120,
      retention_policy: {
        grace_days: 14,
        growth_days: 7,
        push_days: 30,
        repository_limit: 1_000,
      },
      repositories: [{
        full_name: "alpha/one",
        first_seen_at: "2026-08-20T08:00:00.000Z",
        latest_captured_at: "2026-08-26T08:00:00.000Z",
        latest_pushed_at: "2026-08-26T07:00:00.000Z",
        latest_rank: 2,
        latest_stars: 42,
        growth_comparison_stars: 30,
        observations: [{ captured_at: "2026-08-26T08:00:00.000Z", stars: 42 }],
      }],
    })).toEqual({
      latestCapturedAt: "2026-08-26T08:00:00.000Z",
      intervalMinutes: 120,
      retentionPolicy: {
        graceDays: 14,
        growthDays: 7,
        pushDays: 30,
        repositoryLimit: 1_000,
      },
      repositories: [{
        fullName: "alpha/one",
        firstSeenAt: "2026-08-20T08:00:00.000Z",
        latestCapturedAt: "2026-08-26T08:00:00.000Z",
        latestPushedAt: "2026-08-26T07:00:00.000Z",
        latestRank: 2,
        latestStars: 42,
        growthComparisonStars: 30,
        observations: [{ capturedAt: "2026-08-26T08:00:00.000Z", stars: 42 }],
      }],
    });
  });

  it("rejects duplicate repositories and invalid observations", () => {
    expect(() => parseCollectionContext({
      latest_captured_at: null,
      interval_minutes: 120,
      retention_policy: {
        grace_days: 14,
        growth_days: 7,
        push_days: 30,
        repository_limit: 1_000,
      },
      repositories: [
        {
          full_name: "alpha/one",
          first_seen_at: "2026-08-20T08:00:00.000Z",
          latest_captured_at: "2026-08-26T08:00:00.000Z",
          latest_pushed_at: "2026-08-26T07:00:00.000Z",
          latest_rank: 2,
          latest_stars: 42,
          growth_comparison_stars: null,
          observations: [],
        },
        {
          full_name: "ALPHA/ONE",
          first_seen_at: "2026-08-20T08:00:00.000Z",
          latest_captured_at: "2026-08-26T08:00:00.000Z",
          latest_pushed_at: "2026-08-26T07:00:00.000Z",
          latest_rank: 2,
          latest_stars: 42,
          growth_comparison_stars: null,
          observations: [],
        },
      ],
    })).toThrow("duplicate repository");
    expect(() => parseCollectionContext({
      latest_captured_at: null,
      interval_minutes: 120,
      retention_policy: {
        grace_days: 14,
        growth_days: 7,
        push_days: 30,
        repository_limit: 1_000,
      },
      repositories: [{
        full_name: "alpha/one",
        first_seen_at: "2026-08-20T08:00:00.000Z",
        latest_captured_at: "2026-08-26T08:00:00.000Z",
        latest_pushed_at: "2026-08-26T07:00:00.000Z",
        latest_rank: 2,
        latest_stars: 42,
        growth_comparison_stars: null,
        observations: [{ captured_at: "2026-08-26T08:00:00.000Z", stars: -1 }],
      }],
    })).toThrow("non-negative integer");
  });
});

describe("RemoteHistoryApi", () => {
  it("sends collector authorization to PostgREST RPCs", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const api = new RemoteHistoryApi({
      baseUrl: "https://radar.example.com/",
      collectorToken: "collector-token",
      fetchImplementation: fetchMock as typeof fetch,
    });

    await api.startCollection(
      "00000000-0000-4000-8000-000000000001",
      "2026-08-26T08:00:00.000Z",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://radar.example.com/rpc/start_collection",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer collector-token" }),
      }),
    );
  });

  it("surfaces PostgREST failures with their response body", async () => {
    const api = new RemoteHistoryApi({
      baseUrl: "https://radar.example.com",
      collectorToken: "collector-token",
      fetchImplementation: vi.fn(async () => new Response(
        JSON.stringify({ message: "active lease exists" }),
        { status: 409 },
      )) as typeof fetch,
    });

    await expect(api.startCollection(
      "00000000-0000-4000-8000-000000000001",
      "2026-08-26T08:00:00.000Z",
    )).rejects.toThrow("active lease exists");
  });
});

describe("parseSnapshotTimeline", () => {
  it("parses persisted snapshot metadata", () => {
    expect(parseSnapshotTimeline([{
      id: "00000000-0000-4000-8000-000000000001",
      captured_at: "2026-08-26T08:00:00.000Z",
      source: "github-search",
      repository_count: 42,
    }])).toEqual([{
      id: "00000000-0000-4000-8000-000000000001",
      capturedAt: "2026-08-26T08:00:00.000Z",
      source: "github-search",
      repositoryCount: 42,
    }]);
  });

  it("rejects duplicate and malformed snapshot metadata", () => {
    const snapshot = {
      id: "00000000-0000-4000-8000-000000000001",
      captured_at: "2026-08-26T08:00:00.000Z",
      source: "github-search",
      repository_count: 42,
    };
    expect(() => parseSnapshotTimeline([snapshot, snapshot])).toThrow("duplicate snapshot");
    expect(() => parseSnapshotTimeline([{ ...snapshot, repository_count: 0 }])).toThrow(
      "positive integer",
    );
  });
});
