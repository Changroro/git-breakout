import { describe, expect, it, vi } from "vitest";
import { CloudflareTrafficAnalytics } from "./cloudflare-traffic.ts";

const config = {
  apiToken: "test-token",
  hostname: "gitbreakout.imbch.dev",
  zoneId: "0123456789abcdef0123456789abcdef",
};

function successfulResponse(visits: number): Response {
  return new Response(JSON.stringify({
    data: {
      viewer: {
        zones: [{ traffic: [{ dimensions: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36" }, sum: { visits } }] }],
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
      clientRequestHTTPHost: "gitbreakout.imbch.dev",
      datetime_geq: "2026-08-31T15:00:00.000Z",
      datetime_lt: "2026-09-01T03:15:00.000Z",
      requestSource: "eyeball",
      edgeResponseContentTypeName: "html",
    });

    now = new Date("2026-09-01T03:20:01.000Z");
    await analytics.readDailyTraffic();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("counts only visits from likely human browsers", async () => {
    const traffic = [
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36", 5],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1", 3],
      ["Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)", 40],
      ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36", 30],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1", 20],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36", 10],
      ["Mediapartners-Google", 4],
      ["", 7],
    ].map(([userAgent, visits]) => ({ dimensions: { userAgent }, sum: { visits } }));
    const analytics = new CloudflareTrafficAnalytics(config, {
      fetchImplementation: async () => new Response(JSON.stringify({
        data: { viewer: { zones: [{ traffic }] } },
        errors: null,
      })),
      now: () => new Date("2026-09-01T03:15:00.000Z"),
    });

    await expect(analytics.readDailyTraffic()).resolves.toMatchObject({ visits: 8 });
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
