import { describe, expect, it } from "vitest";
import { classifyDiscovery } from "./discovery-classification";
import type { RepositoryStarHistory } from "./trend-intelligence";

const now = "2026-09-09T12:00:00.000Z";
const repository = { full_name: "owner/repo", official_ranks: { daily: null, weekly: null, monthly: null } };
const origin = { full_name: "owner/repo", first_observed_at: "2026-08-01T00:00:00.000Z",
  first_observed_stars: 100, first_observation_was_trending: false, official_trending_episode_count: 0 };
function history(past: number, quiet: number, recent: number, days = 29): RepositoryStarHistory {
  const end = Date.parse("2026-09-09T00:00:00.000Z");
  return { full_name: repository.full_name, captured_at: now, days: Array.from({ length: days }, (_, i) => ({
    start: new Date(end - (days-i)*86_400_000).toISOString(), end: new Date(end-(days-i-1)*86_400_000).toISOString(),
    retained_stars_added: i === days-1 ? recent : i >= days-8 ? quiet : past,
  })) };
}

describe("discovery classification", () => {
  it("requires past activity, a quiet week and a recovery, even for small repositories", () => {
    const result = classifyDiscovery(repository, origin, history(20, 2, 25), now);
    expect(result.category).toBe("resurgence");
    expect(result.resurgence_evidence).toMatchObject({ past_daily_average: 20, quiet_daily_average: 2, recent_daily_gain: 25 });
  });
  it("keeps newly discovered repositories outside recorded Trending history in discovery", () => {
    expect(classifyDiscovery(repository, origin, history(0, 0, 25), now).category).toBe("discovery");
  });
  it("does not call steadily popular or still-dormant repositories a resurgence", () => {
    const established = { ...origin, first_observed_stars: 50_000 };
    for (const sample of [history(20,20,25), history(20,2,3), history(0,0,25), history(20,2,0)]) {
      expect(classifyDiscovery(repository, established, sample, now).category).toBeNull();
    }
  });
  it("does not guess a resurgence with too few days or stale history", () => {
    const established = { ...origin, official_trending_episode_count: 1 };
    expect(classifyDiscovery(repository, established, history(20,2,25,22), now).category).toBe("resurgence");
    expect(classifyDiscovery(repository, established, history(20,2,25,21), now).category).toBeNull();
    expect(classifyDiscovery(repository, established, history(20,2,25), "2026-09-12T12:00:00.000Z").category).toBeNull();
    expect(classifyDiscovery(repository, established, null, now).category).toBeNull();
  });
  it("requires all seven quiet days to be below the prior activity threshold", () => {
    const sample = history(20,2,25);
    sample.days[21].retained_stars_added = 40;
    expect(classifyDiscovery(repository, { ...origin, first_observed_stars: 10_000 }, sample, now).category).toBeNull();
  });
  it("does not label missing origin, previously Trending or currently Trending repositories as discoveries", () => {
    expect(classifyDiscovery(repository, null, null, now).category).toBeNull();
    expect(classifyDiscovery(repository, { ...origin, official_trending_episode_count: 1 }, null, now).category).toBeNull();
    expect(classifyDiscovery({ ...repository, official_ranks: { daily: 1, weekly: null, monthly: null } }, origin, null, now).category).toBeNull();
  });
  it("excludes incomplete day buckets from resurgence evidence", () => {
    const sample = history(20,2,25);
    sample.days[3].end = sample.days[4].end;
    expect(classifyDiscovery(repository, { ...origin, first_observed_stars: 50_000 }, sample, now).category).toBeNull();
  });
});
