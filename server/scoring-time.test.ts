import { describe, expect, it } from 'vitest';
import { calculateGrowth } from './collector.ts';
import { rankRepositories, type RepositoryCandidate } from '../src/lib/ranking.ts';
import { rankTrendIntelligence, type RepositoryStarHistory } from '../src/lib/trend-intelligence.ts';

const capturedAt = '2026-09-12T12:00:00.000Z';
const hour = 3_600_000;
const before = (hours: number) => new Date(Date.parse(capturedAt) - hours * hour).toISOString();
function candidate(name: string, rate: number, elapsed6 = 6): RepositoryCandidate {
  return {
    full_name: name, url: `https://github.com/${name}`, open_graph_image_url: `https://opengraph.githubassets.com/test/${name}`,
    description: null, language: null, topics: [], observation_sources: ['github_search_created'],
    created_at: before(24 * 90), pushed_at: capturedAt,
    metrics: { stars: 9000, forks: 0, watchers: 0, open_issues: 0 }, official_ranks: { daily: null, weekly: null, monthly: null },
    ...calculateGrowth(9000, capturedAt, [
      { capturedAt: before(elapsed6), stars: 9000 - rate * elapsed6 },
      { capturedAt: before(24), stars: 9000 - rate * 24 },
    ], 120),
  };
}
function ranked(candidates: RepositoryCandidate[], histories: RepositoryStarHistory[] = []) {
  return rankTrendIntelligence(rankRepositories(candidates, capturedAt), [], capturedAt, histories, candidates.map(c => ({
    full_name: c.full_name, first_observed_at: before(24 * 30), first_observed_stars: 100,
    first_observation_was_trending: false, official_trending_episode_count: 0,
  })));
}

describe('observed scoring time contracts', () => {
  it.each([30, 60, 90, 119])('returns no growth before the two-hour baseline (%i minutes)', minutes => {
    const result = calculateGrowth(150, capturedAt, [{ capturedAt: before(minutes / 60), stars: 0 }], 60);
    expect(result.firstObservation).toBe(true);
    expect(Object.values(result.growth)).toEqual([null, null, null]);
    expect(() => rankRepositories([{ ...candidate('fixture/early', 10), ...result }], capturedAt)).not.toThrow();
  });

  it('preserves actual observation endpoints and elapsed duration', () => {
    const result = candidate('fixture/jitter', 100, 6.5);
    expect(result).toHaveProperty('growth_evidence.h6', {
      started_at: before(6.5), ended_at: capturedAt, elapsed_hours: 6.5,
    });
  });

  it('does not invent acceleration from a late six-hour observation', () => {
    const result = ranked([candidate('fixture/jitter', 100, 6.5), candidate('fixture/regular', 50)]);
    expect(result.map(r => r.trend_intelligence.breakout.components.star_acceleration)).toEqual([0.5, 0.5]);
    expect(result[0].trend_intelligence.score_version).toBe('trend-intelligence-v8-shadow');
  });

  it('normalizes six-hour-only velocity using its actual elapsed time', () => {
    const candidates = [candidate('fixture/late', 100, 6.5), candidate('fixture/exact', 100)];
    for (const repository of candidates) {
      repository.growth.stars_delta_24h = null;
      repository.growth_evidence!.h24 = null;
    }
    const result = ranked(candidates);
    expect(result.map(r => r.trend_intelligence.breakout.components.star_velocity)).toEqual([0.5, 0.5]);
    expect(result.find(r => r.full_name === 'fixture/late')!.trend_intelligence.evidence!.star_window_elapsed_hours).toBe(6.5);
    expect(result.find(r => r.full_name === 'fixture/exact')!.trend_intelligence.evidence!.star_window_elapsed_hours).toBe(6);
  });

  it('rejects durations that disagree with the original observation timestamps', () => {
    const repository = candidate('fixture/invalid-evidence', 100);
    repository.growth_evidence!.h6!.elapsed_hours = 24;
    expect(() => rankRepositories([repository], capturedAt)).toThrow('preserve its observation duration');
  });

  it('continues to score old inputs without additive evidence or repository identity', () => {
    const candidates = [candidate('fixture/a', 100), candidate('fixture/b', 50)];
    for (const repository of candidates) delete repository.growth_evidence;
    expect(() => ranked(candidates)).not.toThrow();
  });

  it('makes baseline age and the number of known score components reviewable', () => {
    const candidates = [candidate('fixture/a', 100), candidate('fixture/b', 50)];
    const histories = candidates.map(c => ({ full_name: c.full_name, captured_at: before(24 * 30),
      days: Array.from({ length: 28 }, (_, i) => ({ start: before((58 - i) * 24), end: before((57 - i) * 24), retained_stars_added: 20 })),
    }));
    const intelligence = ranked(candidates, histories)[0].trend_intelligence;
    expect(intelligence).toHaveProperty('evidence.history_fetched_at', before(24 * 30));
    expect(intelligence).toHaveProperty('evidence.baseline_ended_at', before(24 * 30));
    expect(intelligence).toHaveProperty('evidence.baseline_gap_hours', 29 * 24);
    expect(intelligence).toHaveProperty('evidence.discovery_component_count', 4);
    expect(intelligence).toHaveProperty('evidence.current_heat_component_count', 0);
  });
});
