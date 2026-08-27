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
      repositories: [{
        full_name: "alpha/one",
        observations: [{ captured_at: "2026-08-26T08:00:00.000Z", stars: 42 }],
      }],
    })).toEqual({
      latestCapturedAt: "2026-08-26T08:00:00.000Z",
      intervalMinutes: 120,
      repositories: [{
        fullName: "alpha/one",
        observations: [{ capturedAt: "2026-08-26T08:00:00.000Z", stars: 42 }],
      }],
    });
  });

  it("rejects duplicate repositories and invalid observations", () => {
    expect(() => parseCollectionContext({
      latest_captured_at: null,
      interval_minutes: 120,
      repositories: [
        { full_name: "alpha/one", observations: [] },
        { full_name: "ALPHA/ONE", observations: [] },
      ],
    })).toThrow("duplicate repository");
    expect(() => parseCollectionContext({
      latest_captured_at: null,
      interval_minutes: 120,
      repositories: [{
        full_name: "alpha/one",
        observations: [{ captured_at: "invalid", stars: -1 }],
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
