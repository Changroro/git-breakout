import type { OfficialRanks } from "./ranking.js";
import type { RepositoryStarHistory } from "./trend-intelligence.js";

const DAY_MS = 86_400_000;
export const DISCOVERY_INITIAL_STAR_LIMIT = 10_000;
export const RESURGENCE_POLICY = {
  quietDays: 7,
  minimumPriorWeeks: 2,
  maximumPriorWeeks: 12,
  quietFraction: 0.5,
  recoveryMultiple: 2,
  maximumDayAgeHours: 36,
} as const;

export type RepositoryDiscoveryHistory = {
  full_name: string;
  first_observed_at: string;
  first_observed_stars: number;
  first_observation_was_trending: boolean;
  official_trending_episode_count: number;
};

export type DiscoveryClassification = {
  category: "discovery" | "resurgence" | null;
  resurgence_evidence: {
    source: "github_retained_acquisitions";
    history_fetched_at: string;
    past_daily_average: number;
    prior_weeks: number;
    quiet_daily_average: number;
    recent_daily_gain: number;
    quiet_started_at: string;
    quiet_ended_at: string;
    recent_day_ended_at: string;
  } | null;
};

function resurgenceEvidence(history: RepositoryStarHistory | null, capturedAt: number): DiscoveryClassification["resurgence_evidence"] {
  if (history === null) return null;
  const days = history.days.slice(-(RESURGENCE_POLICY.maximumPriorWeeks * 7 + RESURGENCE_POLICY.quietDays + 1));
  const recent = days.at(-1);
  if (recent === undefined || days.length < RESURGENCE_POLICY.minimumPriorWeeks * 7 + RESURGENCE_POLICY.quietDays + 1) return null;
  if (capturedAt - Date.parse(recent.end) > RESURGENCE_POLICY.maximumDayAgeHours * 3_600_000
    || Date.parse(recent.end) > capturedAt) return null;
  if (days.some((day, i) => Date.parse(day.end) - Date.parse(day.start) !== DAY_MS
    || (i > 0 && day.start !== days[i-1].end))) return null;
  const quietStart = days.length - RESURGENCE_POLICY.quietDays - 1;
  const quiet = days.slice(quietStart, -1);
  const quietDailyAverage = quiet.reduce((sum, day) => sum + day.retained_stars_added, 0) / quiet.length;
  const weeklyAverages: number[] = [];
  for (let end = quietStart; end >= 7; end -= 7) {
    weeklyAverages.push(days.slice(end - 7, end).reduce((sum, day) => sum + day.retained_stars_added, 0) / 7);
  }
  weeklyAverages.sort((left, right) => left - right);
  const middle = Math.floor(weeklyAverages.length / 2);
  const pastDailyAverage = weeklyAverages.length % 2 === 0
    ? (weeklyAverages[middle - 1] + weeklyAverages[middle]) / 2
    : weeklyAverages[middle];
  if (pastDailyAverage <= 0 || quiet.some(day => day.retained_stars_added > pastDailyAverage * RESURGENCE_POLICY.quietFraction)
    || recent.retained_stars_added < Math.max(pastDailyAverage, quietDailyAverage * RESURGENCE_POLICY.recoveryMultiple)) return null;
  return {
    source: "github_retained_acquisitions", history_fetched_at: history.captured_at,
    past_daily_average: pastDailyAverage, prior_weeks: weeklyAverages.length,
    quiet_daily_average: quietDailyAverage, recent_daily_gain: recent.retained_stars_added,
    quiet_started_at: quiet[0].start, quiet_ended_at: quiet.at(-1)!.end, recent_day_ended_at: recent.end,
  };
}

export function classifyDiscovery(
  repository: { full_name: string; official_ranks: OfficialRanks },
  origin: RepositoryDiscoveryHistory | null,
  history: RepositoryStarHistory | null,
  capturedAt: string,
): DiscoveryClassification {
  const timestamp = Date.parse(capturedAt);
  if (!Number.isFinite(timestamp)) throw new TypeError("Classification capture time must be valid");
  if (origin !== null) {
    if (origin.full_name.toLowerCase() !== repository.full_name.toLowerCase()
      || !Number.isFinite(Date.parse(origin.first_observed_at)) || Date.parse(origin.first_observed_at) > timestamp
      || !Number.isInteger(origin.first_observed_stars) || origin.first_observed_stars < 0
      || typeof origin.first_observation_was_trending !== "boolean"
      || !Number.isInteger(origin.official_trending_episode_count) || origin.official_trending_episode_count < 0) {
      throw new TypeError(`Invalid discovery history for ${repository.full_name}`);
    }
  }
  const evidence = resurgenceEvidence(history, timestamp);
  if (evidence !== null) return { category: "resurgence", resurgence_evidence: evidence };
  const discovery = origin !== null && origin.first_observed_stars < DISCOVERY_INITIAL_STAR_LIMIT
    && !origin.first_observation_was_trending && origin.official_trending_episode_count === 0
    && Object.values(repository.official_ranks).every(rank => rank === null);
  return { category: discovery ? "discovery" : null, resurgence_evidence: null };
}
