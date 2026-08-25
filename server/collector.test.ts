import { describe, expect, it } from "vitest";
import { calculateGrowth } from "./collector.ts";

describe("calculateGrowth", () => {
  it("uses matching historical observations without inventing a one-hour window", () => {
    const capturedAt = "2026-08-25T00:00:00.000Z";
    const result = calculateGrowth(130, capturedAt, [
      { capturedAt: "2026-08-24T22:00:00.000Z", stars: 126 },
      { capturedAt: "2026-08-24T18:00:00.000Z", stars: 118 },
      { capturedAt: "2026-08-24T00:00:00.000Z", stars: 100 },
    ]);

    expect(result.growth).toEqual({
      stars_delta_1h: null,
      stars_delta_6h: 12,
      stars_delta_24h: 30,
    });
    expect(result.observedStarsPerDay).toBe(48);
    expect(result.firstObservation).toBe(false);
  });

  it("marks a repository without history as a first observation", () => {
    expect(calculateGrowth(10, "2026-08-25T00:00:00.000Z", [])).toEqual({
      growth: {
        stars_delta_1h: null,
        stars_delta_6h: null,
        stars_delta_24h: null,
      },
      observedStarsPerDay: null,
      firstObservation: true,
    });
  });
});
