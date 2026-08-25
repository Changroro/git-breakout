export const BASELINE_V1_WEIGHTS = {
  observedGrowth: 55,
  lifetimeVelocity: 28,
  stars: 5,
  forks: 2,
  openIssues: 0.5,
  recentPushMaximum: 14,
  firstObservation: 12,
} as const;

export type Confidence = "low" | "medium" | "high";

export interface RepositoryMetrics {
  stars: number | null;
  forks: number | null;
  watchers: number | null;
  open_issues: number | null;
}

export interface OfficialRanks {
  daily: number | null;
  weekly: number | null;
  monthly: number | null;
}

export interface RepositoryGrowth {
  stars_delta_1h: number | null;
  stars_delta_6h: number | null;
  stars_delta_24h: number | null;
}

export interface RepositoryCandidate {
  full_name: string;
  url: string;
  open_graph_image_url: string;
  description: string | null;
  language: string | null;
  topics: string[];
  created_at: string | null;
  pushed_at: string | null;
  metrics: RepositoryMetrics;
  official_ranks: OfficialRanks;
  growth: RepositoryGrowth;
  observedStarsPerDay: number | null;
  firstObservation: boolean;
}

export interface ScoreComponents {
  observed_growth_score: number | null;
  lifetime_velocity_score: number | null;
  activity_score: number | null;
  official_signal_score: 0;
  size_score: number | null;
  forks_score: number | null;
  open_issues_score: number | null;
  recent_push_score: number | null;
  first_observation_score: 0 | 12;
  observation_count: number;
  metric_completeness: number;
}

export interface RankedRepository extends RepositoryCandidate {
  rank: number;
  momentum: {
    score: number;
    score_version: "baseline-v1";
    confidence: Confidence;
    reasons: string[];
    components: ScoreComponents;
  };
}

function requireNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} must be a finite non-negative number`);
  }
}

function validateNullableMetric(value: number | null, field: string): void {
  if (value !== null) {
    requireNonNegative(value, field);
  }
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${field} must be a valid ISO-8601 timestamp`);
  }
  return timestamp;
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function nullableWeightedLog(value: number | null, weight: number): number | null {
  return value === null ? null : Math.log1p(value) * weight;
}

function addKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

function countObservations(growth: RepositoryGrowth): number {
  return [growth.stars_delta_1h, growth.stars_delta_6h, growth.stars_delta_24h].filter(
    (value) => value !== null,
  ).length;
}

function metricCompleteness(metrics: RepositoryMetrics): number {
  const values = [metrics.stars, metrics.forks, metrics.watchers, metrics.open_issues];
  return values.filter((value) => value !== null).length / values.length;
}

function confidenceFor(
  firstObservation: boolean,
  observationCount: number,
  completeness: number,
): Confidence {
  if (firstObservation) {
    return "low";
  }
  if (observationCount === 3 && completeness === 1) {
    return "high";
  }
  if (observationCount >= 1 && completeness >= 0.75) {
    return "medium";
  }
  return "low";
}

function reasonsFor(candidate: RepositoryCandidate, recentPushScore: number | null): string[] {
  const reasons: string[] = [];
  if (candidate.official_ranks.daily !== null) reasons.push("official_daily_rank");
  if (candidate.official_ranks.weekly !== null) reasons.push("official_weekly_rank");
  if (candidate.official_ranks.monthly !== null) reasons.push("official_monthly_rank");
  if (candidate.growth.stars_delta_1h !== null && candidate.growth.stars_delta_1h > 0) {
    reasons.push("rapid_star_growth_1h");
  }
  if (candidate.growth.stars_delta_24h !== null && candidate.growth.stars_delta_24h > 0) {
    reasons.push("rapid_star_growth_24h");
  }
  if (recentPushScore !== null && recentPushScore > 0) reasons.push("recently_active");
  return reasons;
}

function scoreCandidate(candidate: RepositoryCandidate, capturedAt: number): RankedRepository {
  const openGraphImageUrl = URL.parse(candidate.open_graph_image_url);
  if (openGraphImageUrl === null || openGraphImageUrl.protocol !== "https:") {
    throw new TypeError("open_graph_image_url must be a valid HTTPS URL");
  }
  validateNullableMetric(candidate.metrics.stars, "metrics.stars");
  validateNullableMetric(candidate.metrics.forks, "metrics.forks");
  validateNullableMetric(candidate.metrics.watchers, "metrics.watchers");
  validateNullableMetric(candidate.metrics.open_issues, "metrics.open_issues");
  validateNullableMetric(candidate.growth.stars_delta_1h, "growth.stars_delta_1h");
  validateNullableMetric(candidate.growth.stars_delta_6h, "growth.stars_delta_6h");
  validateNullableMetric(candidate.growth.stars_delta_24h, "growth.stars_delta_24h");

  if (candidate.firstObservation) {
    if (candidate.observedStarsPerDay !== null) {
      throw new TypeError("observedStarsPerDay must be null for the first observation");
    }
    if (countObservations(candidate.growth) !== 0) {
      throw new TypeError("growth windows must be null for the first observation");
    }
  } else if (candidate.observedStarsPerDay === null) {
    throw new TypeError("observedStarsPerDay is required after the first observation");
  } else {
    requireNonNegative(candidate.observedStarsPerDay, "observedStarsPerDay");
  }

  const stars = candidate.metrics.stars;
  const createdAt = candidate.created_at === null ? null : parseTimestamp(candidate.created_at, "created_at");
  const pushedAt = candidate.pushed_at === null ? null : parseTimestamp(candidate.pushed_at, "pushed_at");
  const ageDays = createdAt === null ? null : Math.max((capturedAt - createdAt) / 86_400_000, 0.5);
  const lifetimeVelocity = stars === null || ageDays === null ? null : stars / ageDays;
  const observedGrowthScore =
    candidate.observedStarsPerDay === null
      ? null
      : Math.log1p(candidate.observedStarsPerDay) * BASELINE_V1_WEIGHTS.observedGrowth;
  const lifetimeVelocityScore = nullableWeightedLog(
    lifetimeVelocity,
    BASELINE_V1_WEIGHTS.lifetimeVelocity,
  );
  const sizeScore = nullableWeightedLog(stars, BASELINE_V1_WEIGHTS.stars);
  const forksScore = nullableWeightedLog(candidate.metrics.forks, BASELINE_V1_WEIGHTS.forks);
  const openIssuesScore = nullableWeightedLog(
    candidate.metrics.open_issues,
    BASELINE_V1_WEIGHTS.openIssues,
  );
  const recentPushScore =
    pushedAt === null
      ? null
      : Math.max(
          0,
          BASELINE_V1_WEIGHTS.recentPushMaximum -
            Math.max((capturedAt - pushedAt) / 86_400_000, 0),
        );
  const activityScore = addKnown([forksScore, openIssuesScore, recentPushScore]);
  const firstObservationScore = candidate.firstObservation
    ? BASELINE_V1_WEIGHTS.firstObservation
    : 0;
  const observationCount = countObservations(candidate.growth);
  const completeness = metricCompleteness(candidate.metrics);
  const score = addKnown([
    observedGrowthScore,
    lifetimeVelocityScore,
    sizeScore,
    activityScore,
    firstObservationScore,
  ]);
  if (score === null) {
    throw new TypeError(`cannot score ${candidate.full_name} without any baseline-v1 components`);
  }

  return {
    ...candidate,
    topics: [...candidate.topics],
    metrics: { ...candidate.metrics },
    official_ranks: { ...candidate.official_ranks },
    growth: { ...candidate.growth },
    rank: 0,
    momentum: {
      score: rounded(score),
      score_version: "baseline-v1",
      confidence: confidenceFor(candidate.firstObservation, observationCount, completeness),
      reasons: reasonsFor(candidate, recentPushScore),
      components: {
        observed_growth_score: observedGrowthScore === null ? null : rounded(observedGrowthScore),
        lifetime_velocity_score:
          lifetimeVelocityScore === null ? null : rounded(lifetimeVelocityScore),
        activity_score: activityScore === null ? null : rounded(activityScore),
        official_signal_score: 0,
        size_score: sizeScore === null ? null : rounded(sizeScore),
        forks_score: forksScore === null ? null : rounded(forksScore),
        open_issues_score: openIssuesScore === null ? null : rounded(openIssuesScore),
        recent_push_score: recentPushScore === null ? null : rounded(recentPushScore),
        first_observation_score: firstObservationScore,
        observation_count: observationCount,
        metric_completeness: completeness,
      },
    },
  };
}

export function rankRepositories(
  candidates: readonly RepositoryCandidate[],
  capturedAt: string | Date,
): RankedRepository[] {
  const capturedTimestamp =
    capturedAt instanceof Date ? capturedAt.getTime() : parseTimestamp(capturedAt, "capturedAt");
  if (!Number.isFinite(capturedTimestamp)) {
    throw new TypeError("capturedAt must be a valid date");
  }

  return candidates
    .map((candidate) => scoreCandidate(candidate, capturedTimestamp))
    .sort(
      (left, right) =>
        right.momentum.score - left.momentum.score || left.full_name.localeCompare(right.full_name),
    )
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
