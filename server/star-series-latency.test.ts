import { expect, it, vi } from "vitest";
import { enrichStarSeries } from "./star-history.ts";

it("returns observed points without waiting for a cold GitHub history request", async () => {
  const points = [{ captured_at: "2026-09-09T00:00:00.000Z", stars: 100 }];
  const response = { schema_version: "1.0" as const, series: [{ full_name: "owner/repo", points }] };
  const refreshInBackground = vi.fn();
  const read = vi.fn(() => new Promise<never>(() => {}));
  const store = { read, readCached: () => null, refreshInBackground };
  const waiting = enrichStarSeries(response, "2026-09-09T12:00:00.000Z", store);
  const visible = await Promise.race([waiting, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
  expect(visible?.series[0]).toEqual({ full_name: "owner/repo", points, source: "observed" });
  expect(read).not.toHaveBeenCalled();
  expect(refreshInBackground).toHaveBeenCalledOnce();
});

it("uses fresh cached history without scheduling a refresh", async () => {
  const refreshInBackground = vi.fn();
  const result = await enrichStarSeries({ schema_version: "1.0", series: [{ full_name: "owner/repo", points: [] }] },
    "2026-09-09T12:00:00.000Z", {
      readCached: () => ({ fresh: true, history: { schema_version: "1.0", full_name: "owner/repo",
        fetched_at: "2026-09-09T12:00:00.000Z", complete: true, days: [{ start: "2026-09-08T00:00:00.000Z", end: "2026-09-09T00:00:00.000Z", stars_added: 10 }] } }),
      refreshInBackground,
    });
  expect(result.series[0].source).toBe("github_retained_acquisitions");
  expect(refreshInBackground).not.toHaveBeenCalled();
});
