import { describe, expect, it } from "vitest";
import { buildSparklinePoints, parseStarSeriesResponse } from "./star-series";

const response = {
  schema_version: "1.0",
  series: [{
    full_name: "owner/repository",
    points: [
      { captured_at: "2026-08-27T00:00:00.000Z", stars: 10 },
      { captured_at: "2026-08-27T02:00:00.000Z", stars: 12 },
      { captured_at: "2026-08-27T06:00:00.000Z", stars: 15 },
    ],
  }],
} as const;

describe("star series", () => {
  it("parses ordered repository observations", () => {
    expect(parseStarSeriesResponse(response)).toEqual(response);
    expect(parseStarSeriesResponse({
      ...response,
      series: [{ ...response.series[0], source: "github_retained_acquisitions" }],
    }).series[0].source).toBe("github_retained_acquisitions");
  });

  it("rejects an unknown series meaning", () => {
    expect(() => parseStarSeriesResponse({
      ...response,
      series: [{ ...response.series[0], source: "historical_totals" }],
    })).toThrow("source is invalid");
  });

  it("rejects observations that are not ordered by capture time", () => {
    const reversed = {
      ...response,
      series: [{
        ...response.series[0],
        points: [...response.series[0].points].reverse(),
      }],
    };
    expect(() => parseStarSeriesResponse(reversed)).toThrow("Star series 0 point 1 is invalid");
  });

  it("positions points using elapsed time", () => {
    expect(buildSparklinePoints(response.series[0].points, 100, 40, 5)).toBe(
      "5.0,35.0 35.0,23.0 95.0,5.0",
    );
  });

  it("centers a flat series vertically", () => {
    expect(buildSparklinePoints([
      { captured_at: "2026-08-27T00:00:00.000Z", stars: 10 },
      { captured_at: "2026-08-27T02:00:00.000Z", stars: 10 },
    ], 100, 40, 5)).toBe("5.0,20.0 95.0,20.0");
  });
});
