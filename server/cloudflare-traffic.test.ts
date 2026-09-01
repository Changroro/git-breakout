import { describe, expect, it, vi } from "vitest";
import { CloudflareTrafficAnalytics } from "./cloudflare-traffic.ts";

const config = {
  apiToken: "test-token",
  hostname: "github-trend-radar.imbch.dev",
  zoneId: "0123456789abcdef0123456789abcdef",
};

function successfulResponse(visits: number): Response {
  return new Response(JSON.stringify({
    data: {
      viewer: {
        zones: [{ traffic: [{ sum: { visits } }] }],
      },
    },
    errors: null,
  }), { headers: { "Content-Type": "application/json" } });
}

describe("CloudflareTrafficAnalytics", () => {
  it("queries KST daily visits for the configured hostname and caches them for five minutes", async () => {
    let now = new Date("2026-09-01T03:15:00.000Z");
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () => successfulResponse(15));
    const analytics = new CloudflareTrafficAnalytics(config, {
      fetchImplementation,
      now: () => now,
    });

    await expect(analytics.readDailyTraffic()).resolves.toEqual({
      schema_version: "1.0",
      date: "2026-09-01",
      time_zone: "Asia/Seoul",
      visits: 15,
      generated_at: "2026-09-01T03:15:00.000Z",
    });
    await analytics.readDailyTraffic();
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const request = fetchImplementation.mock.calls[0];
    const body = JSON.parse(String(request?.[1]?.body)) as {
      variables: { filter: Record<string, string> };
    };
    expect(body.variables.filter).toEqual({
      clientRequestHTTPHost: "github-trend-radar.imbch.dev",
      datetime_geq: "2026-08-31T15:00:00.000Z",
      datetime_lt: "2026-09-01T03:15:00.000Z",
      requestSource: "eyeball",
    });

    now = new Date("2026-09-01T03:20:01.000Z");
    await analytics.readDailyTraffic();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("returns zero for an empty traffic result", async () => {
    const analytics = new CloudflareTrafficAnalytics(config, {
      fetchImplementation: async () => new Response(JSON.stringify({
        data: { viewer: { zones: [{ traffic: [] }] } },
        errors: null,
      })),
      now: () => new Date("2026-09-01T03:15:00.000Z"),
    });

    await expect(analytics.readDailyTraffic()).resolves.toMatchObject({ visits: 0 });
  });

  it("rejects invalid responses instead of masking failures", async () => {
    const analytics = new CloudflareTrafficAnalytics(config, {
      fetchImplementation: async () => new Response(JSON.stringify({
        data: null,
        errors: [{ message: "not authorized" }],
      })),
      now: () => new Date("2026-09-01T03:15:00.000Z"),
    });

    await expect(analytics.readDailyTraffic()).rejects.toThrow("GraphQL errors");
  });
});
