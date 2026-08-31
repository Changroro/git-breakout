import { describe, expect, it } from "vitest";
import {
  parseDiscoveryEvidence,
  parseTrackRecord,
  type TrackRecord,
} from "./discovery-track-record";

function validTrackRecord(): TrackRecord {
  return {
    schema_version: "1.0",
    evidence_started_at: "2026-08-28T00:00:00.000Z",
    generated_at: "2026-08-31T00:00:00.000Z",
    verified_count: 3,
    median_lead_hours: 18,
    conversion_7d: { converted: 2, eligible: 3, rate: 2 / 3 },
    conversion_14d: { converted: 3, eligible: 3, rate: 1 },
    period_hits: { daily: 3, weekly: 2, monthly: 1 },
    recent_hits: [{
      full_name: "owner/repository",
      first_observed_at: "2026-08-29T00:00:00.000Z",
      first_trending_at: "2026-08-29T18:00:00.000Z",
      first_trending_rank: 7,
      lead_hours: 18,
      sources: ["github_search_created"],
      coverage: "complete",
    }],
  };
}

describe("discovery track record", () => {
  it("parses verified discovery evidence and track-record metrics", () => {
    expect(parseDiscoveryEvidence({
      outcome: "verified",
      first_observed_at: "2026-08-29T00:00:00.000Z",
      first_trending_daily_at: "2026-08-29T18:00:00.000Z",
      first_trending_daily_rank: 7,
      lead_hours: 18,
      sources: ["github_search_created"],
      coverage: "complete",
    })).toMatchObject({ outcome: "verified", lead_hours: 18 });
    expect(parseTrackRecord(validTrackRecord())).toEqual(validTrackRecord());
  });

  it("preserves null provenance and rejects an empty known source list", () => {
    const legacy = {
      outcome: "legacy",
      first_observed_at: null,
      first_trending_daily_at: null,
      first_trending_daily_rank: null,
      lead_hours: null,
      sources: null,
      coverage: "unknown",
    };
    expect(parseDiscoveryEvidence(legacy).sources).toBeNull();
    expect(() => parseDiscoveryEvidence({ ...legacy, sources: [] })).toThrow(
      "must contain at least one source or be null",
    );
  });

  it("requires verified outcomes to include paired Trending evidence and lead time", () => {
    expect(() => parseDiscoveryEvidence({
      outcome: "verified",
      first_observed_at: "2026-08-29T00:00:00.000Z",
      first_trending_daily_at: "2026-08-29T18:00:00.000Z",
      first_trending_daily_rank: null,
      lead_hours: null,
      sources: ["github_search_created"],
      coverage: "complete",
    })).toThrow("trending timestamp and rank must both be present or null");
  });

  it("requires conversion rates only when discoveries are eligible", () => {
    const record = validTrackRecord();
    expect(() => parseTrackRecord({
      ...record,
      conversion_7d: { converted: 0, eligible: 0, rate: 0 },
    })).toThrow("rate must be null when eligible is zero");
    expect(() => parseTrackRecord({
      ...record,
      conversion_7d: { converted: 2, eligible: 1, rate: 1 },
    })).toThrow("converted cannot exceed eligible");
  });

  it("distinguishes complete pending evidence from gap-limited evidence", () => {
    const evidence = {
      first_observed_at: "2026-08-29T00:00:00.000Z",
      first_trending_daily_at: null,
      first_trending_daily_rank: null,
      lead_hours: null,
      sources: ["github_search_pushed"],
    };
    expect(parseDiscoveryEvidence({
      ...evidence,
      outcome: "inconclusive",
      coverage: "gap",
    }).outcome).toBe("inconclusive");
    expect(() => parseDiscoveryEvidence({
      ...evidence,
      outcome: "pending",
      coverage: "gap",
    })).toThrow("pending outcome requires complete coverage");
  });

  it("preserves observed Trending evidence for gap-limited outcomes", () => {
    expect(parseDiscoveryEvidence({
      outcome: "inconclusive",
      first_observed_at: "2026-08-29T00:00:00.000Z",
      first_trending_daily_at: "2026-08-29T18:00:00.000Z",
      first_trending_daily_rank: 7,
      lead_hours: 18,
      sources: ["github_search_created"],
      coverage: "gap",
    })).toMatchObject({
      outcome: "inconclusive",
      first_trending_daily_rank: 7,
      lead_hours: 18,
    });
  });

  it("rejects verified outcomes and recent hits with incomplete coverage", () => {
    expect(() => parseDiscoveryEvidence({
      outcome: "verified",
      first_observed_at: "2026-08-29T00:00:00.000Z",
      first_trending_daily_at: "2026-08-29T18:00:00.000Z",
      first_trending_daily_rank: 7,
      lead_hours: 18,
      sources: ["github_search_created"],
      coverage: "gap",
    })).toThrow("verified outcome requires complete coverage");

    const record = validTrackRecord();
    expect(() => parseTrackRecord({
      ...record,
      recent_hits: [{ ...record.recent_hits[0], coverage: "gap" }],
    })).toThrow("coverage must be complete");
  });

  it("rejects verified claims without non-Trending provenance", () => {
    expect(() => parseDiscoveryEvidence({
      outcome: "verified",
      first_observed_at: "2026-08-29T00:00:00.000Z",
      first_trending_daily_at: "2026-08-29T18:00:00.000Z",
      first_trending_daily_rank: 7,
      lead_hours: 18,
      sources: ["retained"],
      coverage: "complete",
    })).toThrow("requires non-Trending discovery provenance");
  });

  it("limits recent verified evidence to five repositories", () => {
    const record = validTrackRecord();
    expect(() => parseTrackRecord({
      ...record,
      recent_hits: Array.from({ length: 6 }, (_, index) => ({
        ...record.recent_hits[0],
        full_name: `owner/repository-${index}`,
      })),
    })).toThrow("cannot contain more than five repositories");
  });
});
