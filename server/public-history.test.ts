import { describe, expect, it, vi } from "vitest";
import { PublicHistoryApi } from "./public-history.ts";

const snapshotId = "11111111-1111-4111-8111-111111111111";
const repository = {
  full_name: "owner/repository",
  open_graph_image_url: "https://opengraph.githubassets.com/example/owner/repository",
  observation_sources: null,
};
const trackRecord = {
  schema_version: "1.0",
  evidence_started_at: null,
  generated_at: "2026-08-27T01:17:00.000Z",
  verified_count: 0,
  median_lead_hours: null,
  conversion_7d: { converted: 0, eligible: 0, rate: null },
  conversion_14d: { converted: 0, eligible: 0, rate: null },
  period_hits: { daily: 0, weekly: 0, monthly: 0 },
  recent_hits: [],
};
const discoveryEvidence = {
  outcome: "legacy",
  first_observed_at: null,
  first_trending_daily_at: null,
  first_trending_daily_rank: null,
  lead_hours: null,
  sources: null,
  coverage: "unknown",
};

describe("PublicHistoryApi", () => {
  it("checks database health through PostgREST", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(
      JSON.stringify({ status: "ok" }),
      { headers: { "Content-Type": "application/json" } },
    ));
    const api = new PublicHistoryApi({ baseUrl: "http://rest:3000", fetchImplementation });

    await expect(api.readHealth()).resolves.toEqual({ status: "ok" });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://rest:3000/rpc/health",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reads timeline metadata without loading repository payloads", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: snapshotId,
        captured_at: "2026-08-27T01:17:00.000Z",
        source: "github_combined",
        repository_count: 1,
      }]), { headers: { "Content-Type": "application/json" } }));
    const api = new PublicHistoryApi({
      baseUrl: "http://rest:3000/",
      fetchImplementation,
    });

    await expect(api.readTimeline()).resolves.toEqual({
      schema_version: "1.0",
      snapshots: [{
        id: snapshotId,
        captured_at: "2026-08-27T01:17:00.000Z",
        source: "github_combined",
        repository_count: 1,
      }],
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("loads one selected snapshot", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: snapshotId,
        captured_at: "2026-08-27T01:17:00.000Z",
        source: "github_combined",
        repository_count: 1,
      }]), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([repository]), {
        headers: { "Content-Type": "application/json" },
      }));
    const api = new PublicHistoryApi({ baseUrl: "http://rest:3000", fetchImplementation });

    await expect(api.readSnapshot(snapshotId)).resolves.toEqual({
      id: snapshotId,
      captured_at: "2026-08-27T01:17:00.000Z",
      source: "github_combined",
      repositories: [repository],
    });
    expect(fetchImplementation).toHaveBeenNthCalledWith(
      2,
      "http://rest:3000/rpc/snapshot_repositories",
      expect.objectContaining({ body: JSON.stringify({ p_snapshot_id: snapshotId }) }),
    );
  });

  it("loads one filtered ranking page without requesting the full snapshot", async () => {
    const response = {
      schema_version: "1.0",
      id: snapshotId,
      captured_at: "2026-08-27T01:17:00.000Z",
      source: "github_combined",
      repository_count: 2500,
      matching_count: 42,
      page: 2,
      page_size: 10,
      intelligence_available: true,
      track_record: trackRecord,
      languages: [{ value: "typescript", label: "TypeScript", count: 100 }],
      topics: [{ value: "ai", label: "ai", count: 80 }],
      repositories: [{ ...repository, discovery_evidence: discoveryEvidence }],
    };
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(
      JSON.stringify(response),
      { headers: { "Content-Type": "application/json" } },
    ));
    const api = new PublicHistoryApi({ baseUrl: "http://rest:3000", fetchImplementation });

    await expect(api.readRankingPage({
      snapshotId,
      page: 2,
      pageSize: 10,
      language: "typescript",
      topic: "ai",
      view: "breakout",
    })).resolves.toMatchObject({ page: 2, matching_count: 42 });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://rest:3000/rpc/snapshot_page",
      expect.objectContaining({
        body: JSON.stringify({
          p_snapshot_id: snapshotId,
          p_page: 2,
          p_page_size: 10,
          p_language: "typescript",
          p_topic: "ai",
          p_view: "breakout",
        }),
      }),
    );
  });

  it("searches a selected snapshot with a bounded result count", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(
      JSON.stringify({ schema_version: "1.0", total_count: 1, repositories: [repository] }),
      { headers: { "Content-Type": "application/json" } },
    ));
    const api = new PublicHistoryApi({ baseUrl: "http://rest:3000", fetchImplementation });

    await expect(api.searchRepositories(snapshotId, "owner", 10)).resolves.toMatchObject({
      total_count: 1,
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://rest:3000/rpc/search_snapshot_repositories",
      expect.objectContaining({
        body: JSON.stringify({
          p_snapshot_id: snapshotId,
          p_query: "owner",
          p_limit: 10,
        }),
      }),
    );
  });

  it("rejects a repository count mismatch", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: snapshotId,
        captured_at: "2026-08-27T01:17:00.000Z",
        source: "github_combined",
        repository_count: 2,
      }]), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([repository]), {
        headers: { "Content-Type": "application/json" },
      }));
    const api = new PublicHistoryApi({ baseUrl: "http://rest:3000", fetchImplementation });

    await expect(api.readSnapshot(snapshotId)).rejects.toThrow(
      `Snapshot ${snapshotId} expected 2 repositories, received 1`,
    );
  });

  it("rejects an invalid internal API URL", () => {
    expect(() => new PublicHistoryApi({ baseUrl: "file:///tmp/api" })).toThrow(
      "TREND_RADAR_INTERNAL_API_URL must be an HTTP URL",
    );
  });

  it("loads repository star series through one RPC", async () => {
    const starSeries = {
      schema_version: "1.0",
      series: [{
        full_name: "owner/repository",
        points: [
          { captured_at: "2026-08-27T01:17:00.000Z", stars: 10 },
          { captured_at: "2026-08-27T03:17:00.000Z", stars: 15 },
        ],
      }],
    };
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(
      JSON.stringify(starSeries),
      { headers: { "Content-Type": "application/json" } },
    ));
    const api = new PublicHistoryApi({ baseUrl: "http://rest:3000", fetchImplementation });

    await expect(api.readStarSeries(snapshotId, ["owner/repository"])).resolves.toEqual(starSeries);
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://rest:3000/rpc/repository_star_series",
      expect.objectContaining({
        body: JSON.stringify({
          p_snapshot_id: snapshotId,
          p_full_names: ["owner/repository"],
        }),
      }),
    );
  });
});
