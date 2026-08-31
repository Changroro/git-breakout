import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebServer } from "./web-server.ts";

const snapshotId = "11111111-1111-4111-8111-111111111111";
const servers: ReturnType<typeof createWebServer>[] = [];

function testDirectories(): { cacheDirectory: string; staticDirectory: string } {
  const root = mkdtempSync(join(tmpdir(), "trend-radar-web-"));
  const staticDirectory = join(root, "dist");
  mkdirSync(staticDirectory);
  writeFileSync(join(staticDirectory, "index.html"), "<main>Trend Radar</main>");
  return { cacheDirectory: join(root, "cache"), staticDirectory };
}

async function listen(server: ReturnType<typeof createWebServer>): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not receive a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
});

describe("createWebServer", () => {
  it("serves the built application and health endpoint", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(
      JSON.stringify({ status: "ok" }),
      { headers: { "Content-Type": "application/json" } },
    ));
    const server = createWebServer({
      ...testDirectories(),
      internalApiUrl: "http://rest:3000",
    }, { fetchImplementation });
    const baseUrl = await listen(server);

    const page = await fetch(baseUrl);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Trend Radar");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("strict-transport-security")).toContain("max-age=31536000");
    await expect(fetch(`${baseUrl}/archive`).then((response) => response.text())).resolves.toContain(
      "Trend Radar",
    );
    await expect(fetch(`${baseUrl}/track-record`).then((response) => response.text())).resolves.toContain(
      "Trend Radar",
    );
    await expect(fetch(`${baseUrl}/health`).then((response) => response.json())).resolves.toEqual({
      status: "ok",
    });
  });

  it("does not cache mutable ranking pages and serves bounded search results", async () => {
    const repository = {
      full_name: "owner/repository",
      open_graph_image_url: "https://opengraph.githubassets.com/example/owner/repository",
      observation_sources: null,
    };
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema_version: "1.0",
        id: snapshotId,
        captured_at: "2026-08-27T01:17:00.000Z",
        source: "github_combined",
        repository_count: 2500,
        matching_count: 1,
        page: 1,
        page_size: 10,
        intelligence_available: true,
        track_record: {
          schema_version: "1.0",
          evidence_started_at: null,
          generated_at: "2026-08-27T01:17:00.000Z",
          verified_count: 0,
          median_lead_hours: null,
          conversion_7d: { converted: 0, eligible: 0, rate: null },
          conversion_14d: { converted: 0, eligible: 0, rate: null },
          period_hits: { daily: 0, weekly: 0, monthly: 0 },
          recent_hits: [],
        },
        languages: [{ value: "typescript", label: "TypeScript", count: 1 }],
        topics: [{ value: "ai", label: "ai", count: 1 }],
        repositories: [{
          ...repository,
          discovery_evidence: {
            outcome: "legacy",
            first_observed_at: null,
            first_trending_daily_at: null,
            first_trending_daily_rank: null,
            lead_hours: null,
            sources: null,
            coverage: "unknown",
          },
        }],
      }), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema_version: "1.0",
        total_count: 1,
        repositories: [repository],
      }), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema_version: "1.0",
        latest_snapshot_id: snapshotId,
        latest_captured_at: "2026-08-31T01:17:00.000Z",
        archive_count: 1,
        matching_count: 1,
        page: 1,
        page_size: 10,
        repositories: [{
          ...repository,
          rank: 8,
          last_snapshot_id: "22222222-2222-4222-8222-222222222222",
          last_observed_at: "2026-08-30T01:17:00.000Z",
        }],
      }), { headers: { "Content-Type": "application/json" } }));
    const server = createWebServer({
      ...testDirectories(),
      internalApiUrl: "http://rest:3000",
    }, { fetchImplementation });
    const baseUrl = await listen(server);

    const ranking = await fetch(
      `${baseUrl}/api/ranking?snapshot=${snapshotId}&page=1&page_size=10&view=momentum`,
    );
    expect(ranking.status).toBe(200);
    expect(ranking.headers.get("cache-control")).toBe("no-store");
    expect((await ranking.json() as { repositories: unknown[] }).repositories).toHaveLength(1);
    const search = await fetch(
      `${baseUrl}/api/search?snapshot=${snapshotId}&query=owner&limit=10`,
    );
    expect(search.status).toBe(200);
    expect(search.headers.get("cache-control")).toContain("immutable");
    const archive = await fetch(`${baseUrl}/api/archive?page=1&page_size=10&query=owner`);
    expect(archive.status).toBe(200);
    expect(archive.headers.get("cache-control")).toBe("no-store");
    expect((await archive.json() as { repositories: unknown[] }).repositories).toHaveLength(1);
  });

  it("serves timeline, one snapshot, and proxies RPC requests", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: snapshotId,
        captured_at: "2026-08-27T01:17:00.000Z",
        source: "github_combined",
        repository_count: 1,
      }]), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: snapshotId,
        captured_at: "2026-08-27T01:17:00.000Z",
        source: "github_combined",
        repository_count: 1,
      }]), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        full_name: "owner/repository",
        open_graph_image_url: "https://opengraph.githubassets.com/example/owner/repository",
        observation_sources: null,
      }]), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema_version: "1.0",
        series: [{
          full_name: "owner/repository",
          points: [
            { captured_at: "2026-08-27T01:17:00.000Z", stars: 10 },
          ],
        }],
      }), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      }));
    const server = createWebServer({
      ...testDirectories(),
      internalApiUrl: "http://rest:3000",
    }, { fetchImplementation });
    const baseUrl = await listen(server);

    const timelineResponse = await fetch(`${baseUrl}/api/timeline`);
    expect(timelineResponse.status).toBe(200);
    expect((await timelineResponse.json() as { snapshots: unknown[] }).snapshots).toHaveLength(1);
    const snapshotResponse = await fetch(`${baseUrl}/api/snapshot?id=${snapshotId}`);
    expect(snapshotResponse.status).toBe(200);
    expect((await snapshotResponse.json() as { repositories: unknown[] }).repositories).toHaveLength(1);
    const seriesResponse = await fetch(
      `${baseUrl}/api/star-series?snapshot=${snapshotId}&repository=owner%2Frepository`,
    );
    expect(seriesResponse.status).toBe(200);
    expect((await seriesResponse.json() as { series: unknown[] }).series).toHaveLength(1);
    const rpcResponse = await fetch(`${baseUrl}/rpc/health`, {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(rpcResponse.status).toBe(200);
    expect(await rpcResponse.json()).toEqual({ status: "ok" });
    expect(fetchImplementation).toHaveBeenLastCalledWith(
      "http://rest:3000/rpc/health",
      expect.objectContaining({ method: "POST", body: Buffer.from("{}") }),
    );
  });

  it("does not serve files outside the static directory", async () => {
    const server = createWebServer({
      ...testDirectories(),
      internalApiUrl: "http://rest:3000",
    });
    const baseUrl = await listen(server);

    expect((await fetch(`${baseUrl}/..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/unknown-page`)).status).toBe(404);
  });
});
