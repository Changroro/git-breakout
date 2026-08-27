import { describe, expect, it } from "vitest";
import { calculateGrowth, millisecondsUntilNextCollection } from "./collector.ts";

describe("calculateGrowth", () => {
  it("uses matching historical observations without inventing a one-hour window", () => {
    const capturedAt = "2026-08-25T00:00:00.000Z";
    const result = calculateGrowth(130, capturedAt, [
      { capturedAt: "2026-08-24T22:00:00.000Z", stars: 126 },
      { capturedAt: "2026-08-24T18:00:00.000Z", stars: 118 },
      { capturedAt: "2026-08-24T00:00:00.000Z", stars: 100 },
    ], 120);

    expect(result.growth).toEqual({
      stars_delta_1h: null,
      stars_delta_6h: 12,
      stars_delta_24h: 30,
    });
    expect(result.observedStarsPerDay).toBe(48);
    expect(result.firstObservation).toBe(false);
  });

  it("marks a repository without history as a first observation", () => {
    expect(calculateGrowth(10, "2026-08-25T00:00:00.000Z", [], 120)).toEqual({
      growth: {
        stars_delta_1h: null,
        stars_delta_6h: null,
        stars_delta_24h: null,
      },
      observedStarsPerDay: null,
      firstObservation: true,
    });
  });

  it("keeps a two-hour baseline when a manual observation occurs early", () => {
    const result = calculateGrowth(130, "2026-08-25T00:00:00.000Z", [
      { capturedAt: "2026-08-24T23:00:00.000Z", stars: 129 },
      { capturedAt: "2026-08-24T22:00:00.000Z", stars: 126 },
    ], 120);

    expect(result.observedStarsPerDay).toBe(48);
    expect(result.firstObservation).toBe(false);
  });

  it("does not report growth before the two-hour baseline is ready", () => {
    expect(calculateGrowth(130, "2026-08-25T00:00:00.000Z", [
      { capturedAt: "2026-08-24T23:00:00.000Z", stars: 129 },
    ], 120)).toEqual({
      growth: {
        stars_delta_1h: 1,
        stars_delta_6h: null,
        stars_delta_24h: null,
      },
      observedStarsPerDay: null,
      firstObservation: true,
    });
  });
});

describe("millisecondsUntilNextCollection", () => {
  it("waits for the remaining portion of the configured interval", () => {
    expect(millisecondsUntilNextCollection(
      new Date("2026-08-25T01:00:00.000Z"),
      "2026-08-25T00:00:00.000Z",
      120,
    )).toBe(3_600_000);
  });

  it("runs immediately when no completed collection exists or the interval elapsed", () => {
    const now = new Date("2026-08-25T02:00:00.000Z");
    expect(millisecondsUntilNextCollection(now, null, 120)).toBe(0);
    expect(millisecondsUntilNextCollection(now, "2026-08-25T00:00:00.000Z", 120)).toBe(0);
  });
});
