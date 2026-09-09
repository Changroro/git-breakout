import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  enrichStarSeries,
  StarHistoryStore,
  type GitHubStarHistory,
} from "./star-history.ts";

const NOW = new Date("2026-09-05T12:00:00.000Z");

function history(fullName = "owner/repository"): GitHubStarHistory {
  return {
    schema_version: "1.0",
    full_name: fullName,
    fetched_at: NOW.toISOString(),
    complete: true,
    days: [
      { start: "2026-09-02T00:00:00.000Z", end: "2026-09-03T00:00:00.000Z", stars_added: 10 },
      { start: "2026-09-03T00:00:00.000Z", end: "2026-09-04T00:00:00.000Z", stars_added: 20 },
      { start: "2026-09-04T00:00:00.000Z", end: "2026-09-05T00:00:00.000Z", stars_added: 30 },
      { start: "2026-09-05T00:00:00.000Z", end: "2026-09-06T00:00:00.000Z", stars_added: 4 },
    ],
  };
}

describe("review regressions", () => {
  it("does not mix retained-star acquisition history with observed point-in-time totals", async () => {
    const response = await enrichStarSeries(
      {
        schema_version: "1.0",
        series: [{
          full_name: "owner/repository",
          points: [
            { captured_at: "2026-09-04T00:00:00.000Z", stars: 67 },
            { captured_at: "2026-09-05T00:00:00.000Z", stars: 97 },
          ],
        }],
      },
      "2026-09-05T02:00:00.000Z",
      { readCached: vi.fn(() => ({ history: history(), fresh: true })), refreshInBackground: vi.fn() },
      2,
    );

    expect(response.series[0]).toEqual({
      full_name: "owner/repository",
      source: "github_retained_acquisitions",
      points: [
        { captured_at: "2026-09-03T00:00:00.000Z", stars: 0 },
        { captured_at: "2026-09-04T00:00:00.000Z", stars: 20 },
        { captured_at: "2026-09-05T00:00:00.000Z", stars: 50 },
      ],
    });
  });

  it("enforces the configured hourly web request limit before calling GitHub", async () => {
    let current = NOW;
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([
      { week: 1_788_048_000, total: 1, days: [1, 0, 0, 0, 0, 0, 0] },
    ]), { headers: { "Content-Type": "application/json" } }));
    const store = new StarHistoryStore({
      cacheDirectory: join(mkdtempSync(join(tmpdir(), "star-history-review-")), "cache"),
      token: "token",
      fetchImplementation,
      now: () => current,
      hourlyRequestLimit: 1,
    });

    await store.read("owner/first", "2026-08-24T00:00:00.000Z");
    await expect(store.read("owner/second", "2026-08-24T00:00:00.000Z"))
      .rejects.toThrow("hourly request limit");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    current = new Date(NOW.getTime() + 3_600_000);
    await store.read("owner/third", "2026-08-24T00:00:00.000Z");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });
});
