import { describe, expect, it, vi } from "vitest";
import { PublicHistoryApi } from "./public-history.ts";

const snapshotId = "11111111-1111-4111-8111-111111111111";
const repository = {
  full_name: "owner/repository",
  open_graph_image_url: "https://opengraph.githubassets.com/example/owner/repository",
};

describe("PublicHistoryApi", () => {
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
