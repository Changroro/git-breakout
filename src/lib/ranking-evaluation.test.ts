import { describe, expect, it } from "vitest";
import { evaluateRankings, parseRankingEvaluationInput, type RankingEvaluationInput } from "./ranking-evaluation";

const START = Date.parse("2026-09-01T00:00:00Z");
const at = (hours: number) => new Date(START + hours * 3_600_000).toISOString();

function repository(name: string, stars: number | null, score: number | null, baseline = 50) {
  return {
    full_name: `fixture/${name}`, metrics: { stars },
    momentum: { score: baseline, score_version: "baseline-v1" as const },
    trend_intelligence: {
      score_version: "trend-intelligence-v8-shadow", confidence: "low" as const,
      missing_evidence: ["star_history_baseline"],
      breakout: { score, components: { star_velocity: score === null ? null : score / 100, organic_breadth: null } },
      current_heat: { score: null, components: {} },
    },
  };
}

function input(): RankingEvaluationInput {
  return {
    schema_version: "1.0", snapshots: [
      { id: "origin", captured_at: at(0), repositories: [repository("a", 100, 95, 20), repository("b", 200, 80, 100), repository("unscoreable", 5, null, 999)] },
      { id: "next", captured_at: at(25), repositories: [repository("a", 125, 10), repository("b", 190, 99), repository("future", 1_000_000, 100)] },
      { id: "last", captured_at: at(75), repositories: [repository("a", 175, 10), repository("b", 180, 99)] },
    ],
  };
}

describe("offline ranking evaluation", () => {
  it("freezes origin candidates and scores and compares baseline in the same pool", () => {
    const report = evaluateRankings(input(), 1);
    const origin = report.evaluations[0];
    expect(origin.score_version).toBe("trend-intelligence-v8-shadow");
    expect(origin.selected).toEqual([{ full_name: "fixture/a", score: 95 }]);
    expect(origin.baseline).toEqual([{ full_name: "fixture/b", score: 100 }]);
    expect(origin.scoreable_coverage).toBe(2 / 3);
    const changed = input();
    changed.snapshots[1].repositories[0].trend_intelligence!.breakout.score = 100;
    changed.snapshots[1].repositories[1].trend_intelligence!.breakout.score = 0;
    expect(evaluateRankings(changed, 1).evaluations[0].selected).toEqual(origin.selected);
    expect(origin.selected.some(row => row.full_name.includes("future"))).toBe(false);
  });

  it("uses observed endpoint duration, preserves losses, and reports 24/72-hour outcomes", () => {
    const horizons = evaluateRankings(input(), 1).evaluations[0].horizons;
    expect(horizons.map(row => row.hours)).toEqual([24, 72]);
    expect(horizons[0].model.outcomes[0]).toMatchObject({ elapsed_hours: 25, delta_stars: 25, stars_per_day: 24 });
    expect(horizons[0].baseline.mean_delta_stars).toBe(-10);
    expect(horizons[0].baseline.positive_growth_rate).toBe(0);
    expect(horizons[1].model.mean_stars_per_day).toBe(24);
  });

  it("keeps pending and missing follow-up separate from zero growth", () => {
    const data = input();
    data.snapshots[1].repositories = [];
    const report = evaluateRankings(data, 1);
    expect(report.evaluations[0].horizons[0].model).toMatchObject({ missing: 1, observed: 0, mean_delta_stars: null, coverage: 0 });
    const last = report.evaluations.find(row => row.snapshot_id === "last")!;
    expect(last.horizons[0].model).toMatchObject({ pending: 1, missing: 0, mean_delta_stars: null });
  });

  it("does not use observations before the target or after the tolerance window", () => {
    const data = input();
    data.snapshots[1].captured_at = at(23.9);
    expect(evaluateRankings(data, 1).evaluations[0].horizons[0].model.observed).toBe(0);
    data.snapshots[1].captured_at = at(27.01);
    expect(evaluateRankings(data, 1).evaluations[0].horizons[0].model.observed).toBe(0);
    data.snapshots[1].captured_at = at(27);
    expect(evaluateRankings(data, 1).evaluations[0].horizons[0].model.observed).toBe(1);
  });

  it("freezes origin confidence, completeness, and size strata", () => {
    const data = input();
    data.snapshots[1].repositories[0].metrics.stars = 20_000;
    data.snapshots[1].repositories[0].trend_intelligence!.missing_evidence = [];
    const strata = evaluateRankings(data, 1).evaluations[0].horizons[0].model.strata;
    expect(Object.keys(strata)).toEqual(["confidence:low", "evidence:partial", "stars:under_1000"]);
    expect(strata["evidence:partial"].observed).toBe(1);
  });

  it("reports component masking rank changes without claiming production replay", () => {
    const data = input();
    data.snapshots[0].repositories[0].trend_intelligence!.breakout = {
      score: 75, components: { star_velocity: 1, organic_breadth: 0.5 },
    };
    data.snapshots[0].repositories[1].trend_intelligence!.breakout = {
      score: 70, components: { star_velocity: 0.5, organic_breadth: 0.9 },
    };
    const report = evaluateRankings(data, 1);
    const ablation = report.evaluations[0].component_ablations.find(row => row.masked_component === "star_velocity")!;
    expect(ablation.top_k).toEqual(["fixture/b"]);
    expect(ablation.retained_top_k).toBe(0);
    expect(ablation.rank_changes[0]).toEqual({ full_name: "fixture/a", original_rank: 1, masked_rank: 2 });
    expect(report.limitations.join(" ")).toContain("does not replay");
    const single = evaluateRankings(input(), 1).evaluations[0].component_ablations.find(row => row.masked_component === "star_velocity")!;
    expect(single.unscoreable_after_mask).toBe(2);
  });

  it("handles missing starting totals and deterministic ties without mutating input", () => {
    const data = input();
    data.snapshots[0].repositories[0].metrics.stars = null;
    data.snapshots[0].repositories[1].trend_intelligence!.breakout.score = 95;
    const original = JSON.stringify(data);
    const report = evaluateRankings(data, 1);
    expect(report.evaluations[0].selected[0].full_name).toBe("fixture/a");
    expect(report.evaluations[0].horizons[0].model.outcomes[0].status).toBe("missing_start");
    expect(JSON.stringify(data)).toBe(original);
    expect(evaluateRankings(data, 1)).toEqual(report);
  });

  it("keeps different score versions separate", () => {
    const data = input();
    data.snapshots[0].repositories[0].trend_intelligence!.score_version = "trend-intelligence-v7-shadow";
    const origins = evaluateRankings(data, 1).evaluations.filter(row => row.snapshot_id === "origin");
    expect(origins).toHaveLength(2);
    expect(origins.map(row => row.scoreable_count)).toEqual([1, 1]);
  });

  it("uses immutable ids across renames and rejects same-name replacement repositories", () => {
    const data = input();
    data.snapshots[0].repositories[0].repository_id = "R_original";
    data.snapshots[1].repositories[0].repository_id = "R_replacement";
    const replacement = evaluateRankings(data, 1).evaluations[0].horizons[0].model;
    expect(replacement.observed).toBe(0);
    data.snapshots[1].repositories[0].repository_id = "R_original";
    data.snapshots[1].repositories[0].full_name = "transferred/renamed";
    data.snapshots[1].repositories.unshift(repository("a", 50_000, 100));
    expect(evaluateRankings(data, 1).evaluations[0].horizons[0].model.outcomes[0]).toMatchObject({
      status: "observed", identity_basis: "repository_id", observed_full_name: "transferred/renamed",
    });
    expect(evaluateRankings(input(), 1).evaluations[0].horizons[0].model.outcomes[0]).toMatchObject({
      status: "observed", identity_basis: "name_unverified",
    });
  });

  it("rejects missing data contracts, duplicate identities and unordered time", () => {
    expect(() => parseRankingEvaluationInput({ schema_version: "1.0", snapshots: [] })).toThrow();
    const duplicates = input();
    duplicates.snapshots[0].repositories.push(repository("A", 5, 80));
    expect(() => parseRankingEvaluationInput(duplicates)).toThrow("unique");
    const unordered = input();
    unordered.snapshots.reverse();
    expect(() => parseRankingEvaluationInput(unordered)).toThrow("increase strictly");
    const invalidScore = input();
    invalidScore.snapshots[0].repositories[0].trend_intelligence!.breakout.score = 101;
    expect(() => parseRankingEvaluationInput(invalidScore)).toThrow();
    expect(() => evaluateRankings(input(), 0)).toThrow();
    expect(() => evaluateRankings(input(), 1, -1)).toThrow();
  });
});
