import { describe, expect, it } from "vitest";
import { percentileRanks } from "./percentile.js";

describe("percentileRanks", () => {
  it("preserves pairwise midranks for tied, negative and mixed populations", () => {
    for (const population of [[1, 1], [-4, 0, 0, 2, 9], [3, 2, 1], Array.from({ length: 500 }, (_, i) => i % 17)]) {
      const ranks = percentileRanks(population);
      for (const value of population) {
        const below = population.filter(item => item < value).length;
        const equal = population.filter(item => item === value).length;
        expect(ranks.get(value)).toBe((below + (equal - 1) / 2) / (population.length - 1));
      }
    }
  });

  it("leaves undersized populations unscored", () => {
    expect(percentileRanks([]).size).toBe(0);
    expect(percentileRanks([1]).size).toBe(0);
  });
});
