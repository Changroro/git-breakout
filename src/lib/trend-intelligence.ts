import type { Confidence, RankedRepository } from "./ranking.js";

const HOUR_MS = 3_600_000;

export const MIN_TREND_COHORT_SIZE = 8;
export const MAX_EVENT_SIGNAL_AGE_HOURS = 4;

export type TrendPhase =
  | "spark"
  | "breakout"
  | "hot"
  | "steady"
  | "cooling"
  | "insufficient_data";

export type TrendWindowSignals = {
  watches: number;
  forks: number;
  pull_requests: number;
  issues: number;
  issue_comments: number;
  pushes: number;
  releases: number;
  unique_actors: number;
};

export type RepositoryEventSignals = {
  full_name: string;
  captured_at: string;
  windows: {
    h1: TrendWindowSignals;
    h6: TrendWindowSignals;
    h24: TrendWindowSignals;
    h72: TrendWindowSignals;
  };
};

type ScoreComponents = {
  star_velocity: number | null;
  peer_relative_growth: number | null;
  star_acceleration: number | null;
  actor_acceleration: number | null;
  organic_breadth: number | null;
  event_diversity: number | null;
  persistence: number | null;
};

export type TrendScore = {
  score: number | null;
  components: ScoreComponents;
};

export type TrendIntelligence = {
  score_version: "trend-intelligence-v2-shadow";
  phase: TrendPhase;
  confidence: Confidence;
  current_heat: TrendScore;
  breakout: TrendScore;
  cohort: {
    key: string;
    size: number;
  };
  event_data_captured_at: string | null;
  missing_evidence: string[];
  reasons: string[];
};

export type TrendRankedRepository = RankedRepository & {
  trend_intelligence: TrendIntelligence;
};

export function trendIntelligenceFor(repository: RankedRepository): TrendIntelligence | null {
  const value = (repository as RankedRepository & { trend_intelligence?: unknown }).trend_intelligence;
  if (value === undefined) return null;
  if (
    typeof value !== "object"
    || value === null
    || !("score_version" in value)
    || value.score_version !== "trend-intelligence-v2-shadow"
  ) {
    throw new TypeError(`Repository ${repository.full_name} has invalid trend intelligence`);
  }
  return value as TrendIntelligence;
}

type FeatureRow = {
  repository: RankedRepository;
  cohortKey: string;
  eventSignals: RepositoryEventSignals | null;
  missingEvidence: string[];
  starVelocity: number | null;
  relativeGrowth: number | null;
  starAcceleration: number | null;
  actorAcceleration: number | null;
  organicBreadth: number | null;
  eventDiversity: number | null;
  persistence: number | null;
};

function parseTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${field} must be a valid ISO-8601 timestamp`);
  }
  return timestamp;
}

function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
}

function validateWindow(window: TrendWindowSignals, field: string): void {
  Object.entries(window).forEach(([name, value]) => {
    requireNonNegativeInteger(value, `${field}.${name}`);
  });
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function starBand(stars: number): string {
  if (stars < 100) return "lt100";
  if (stars < 1_000) return "100-999";
  if (stars < 10_000) return "1k-9k";
  if (stars < 100_000) return "10k-99k";
  return "gte100k";
}

function ageBand(createdAt: string, capturedAt: number): string {
  const ageDays = Math.max(0, (capturedAt - parseTimestamp(createdAt, "created_at")) / 86_400_000);
  if (ageDays < 30) return "lt30d";
  if (ageDays < 90) return "30-89d";
  if (ageDays < 365) return "90-364d";
  return "gte365d";
}

function cohortKey(repository: RankedRepository, capturedAt: number): string {
  if (repository.created_at === null || repository.metrics.stars === null) {
    return "unavailable";
  }
  const language = repository.language?.trim().toLocaleLowerCase("en-US") || "unknown";
  return `${language}:${ageBand(repository.created_at, capturedAt)}:${starBand(repository.metrics.stars)}`;
}

function percentile(value: number, population: readonly number[]): number {
  if (population.length < 2) {
    throw new RangeError("Percentile population requires at least two values");
  }
  const below = population.filter((candidate) => candidate < value).length;
  const equal = population.filter((candidate) => candidate === value).length;
  return (below + (equal - 1) / 2) / (population.length - 1);
}

function scoreFrom(components: readonly number[]): number | null {
  if (components.length === 0) return null;
  return rounded(components.reduce((sum, value) => sum + value, 0) / components.length * 100);
}

function eventDiversity(window: TrendWindowSignals): number {
  const categories = [
    window.watches,
    window.forks,
    window.pull_requests + window.issues + window.issue_comments,
    window.pushes + window.releases,
  ];
  return categories.filter((count) => count > 0).length / categories.length;
}

function featureRow(
  repository: RankedRepository,
  eventSignals: RepositoryEventSignals | null,
  capturedAt: number,
): FeatureRow {
  const missingEvidence: string[] = [];
  const delta6 = repository.growth.stars_delta_6h;
  const delta24 = repository.growth.stars_delta_24h;
  const stars = repository.metrics.stars;
  if (delta6 === null || delta24 === null) missingEvidence.push("star_windows_6h_24h");

  let freshSignals = eventSignals;
  if (eventSignals === null) {
    missingEvidence.push("github_events");
  } else {
    const eventCapturedAt = parseTimestamp(eventSignals.captured_at, "event_signals.captured_at");
    if (eventCapturedAt > capturedAt) {
      throw new RangeError(`Event signals for ${repository.full_name} cannot be in the future`);
    }
    Object.entries(eventSignals.windows).forEach(([windowName, window]) => {
      validateWindow(window, `event_signals.${repository.full_name}.${windowName}`);
    });
    if (capturedAt - eventCapturedAt > MAX_EVENT_SIGNAL_AGE_HOURS * HOUR_MS) {
      missingEvidence.push("fresh_github_events");
      freshSignals = null;
    }
  }

  const priorStars = stars === null || delta24 === null ? null : Math.max(stars - delta24, 1);
  const starAcceleration = delta6 === null || delta24 === null
    ? null
    : delta6 / 6 - delta24 / 24;
  const actorAcceleration = freshSignals === null
    ? null
    : freshSignals.windows.h6.unique_actors / 6 - freshSignals.windows.h24.unique_actors / 24;
  const persistence = freshSignals === null
    ? null
    : Math.min(
      1,
      freshSignals.windows.h6.unique_actors * 4 /
        Math.max(freshSignals.windows.h24.unique_actors, 1),
    );

  return {
    repository,
    cohortKey: cohortKey(repository, capturedAt),
    eventSignals: freshSignals,
    missingEvidence,
    starVelocity: delta24,
    relativeGrowth: delta24 === null || priorStars === null ? null : delta24 / priorStars,
    starAcceleration,
    actorAcceleration,
    organicBreadth: freshSignals?.windows.h24.unique_actors ?? null,
    eventDiversity: freshSignals === null ? null : eventDiversity(freshSignals.windows.h24),
    persistence,
  };
}

function known(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null);
}

function reasonList(current: ScoreComponents, breakout: ScoreComponents): string[] {
  const reasons: string[] = [];
  if ((breakout.peer_relative_growth ?? 0) >= 0.8) reasons.push("peer_growth_outlier");
  if ((breakout.star_acceleration ?? 0) >= 0.8) reasons.push("accelerating_stars");
  if ((breakout.actor_acceleration ?? 0) >= 0.8) reasons.push("accelerating_community");
  if ((current.organic_breadth ?? 0) >= 0.8) reasons.push("broad_organic_interest");
  if ((current.event_diversity ?? 0) >= 0.75) reasons.push("multi_signal_activity");
  if ((current.persistence ?? 0) >= 0.8) reasons.push("sustained_attention");
  return reasons;
}

function phaseFor(
  currentScore: number | null,
  breakoutScore: number | null,
  starAcceleration: number | null,
  confidence: Confidence,
): TrendPhase {
  if (currentScore === null || breakoutScore === null) return "insufficient_data";
  if (breakoutScore >= 85 && (starAcceleration ?? 0) > 0) return "breakout";
  if (breakoutScore >= 70 && confidence !== "high") return "spark";
  if (currentScore >= 85) return "hot";
  if (currentScore >= 55 && (starAcceleration ?? 0) < 0) return "cooling";
  return "steady";
}

function confidenceFor(row: FeatureRow, cohortSize: number): Confidence {
  if (row.eventSignals === null || cohortSize < MIN_TREND_COHORT_SIZE) return "low";
  const hasAllStarWindows = row.repository.growth.stars_delta_1h !== null
    && row.repository.growth.stars_delta_6h !== null
    && row.repository.growth.stars_delta_24h !== null;
  if (cohortSize >= 20 && hasAllStarWindows && row.eventSignals.windows.h72.unique_actors > 0) {
    return "high";
  }
  return "medium";
}

export function rankTrendIntelligence(
  repositories: readonly RankedRepository[],
  eventSignals: readonly RepositoryEventSignals[],
  capturedAt: string | Date,
): TrendRankedRepository[] {
  const capturedTimestamp = capturedAt instanceof Date
    ? capturedAt.getTime()
    : parseTimestamp(capturedAt, "capturedAt");
  if (!Number.isFinite(capturedTimestamp)) {
    throw new TypeError("capturedAt must be a valid date");
  }

  const signalsByName = new Map<string, RepositoryEventSignals>();
  eventSignals.forEach((signals) => {
    if (!/^[^/\s]+\/[^/\s]+$/.test(signals.full_name)) {
      throw new TypeError("event_signals.full_name must use owner/name format");
    }
    const key = signals.full_name.toLocaleLowerCase("en-US");
    if (signalsByName.has(key)) {
      throw new Error(`Duplicate event signals for ${signals.full_name}`);
    }
    signalsByName.set(key, signals);
  });

  const rows = repositories.map((repository) => featureRow(
    repository,
    signalsByName.get(repository.full_name.toLocaleLowerCase("en-US")) ?? null,
    capturedTimestamp,
  ));
  const cohorts = new Map<string, FeatureRow[]>();
  rows.forEach((row) => {
    const cohort = cohorts.get(row.cohortKey) ?? [];
    cohort.push(row);
    cohorts.set(row.cohortKey, cohort);
  });
  const globallyScoreable = rows.filter((row) =>
    row.starVelocity !== null && row.organicBreadth !== null
  );

  return rows.map((row) => {
    const cohort = cohorts.get(row.cohortKey) ?? [];
    const cohortScoreable = cohort.filter((candidate) =>
      candidate.relativeGrowth !== null
      && candidate.starAcceleration !== null
      && candidate.actorAcceleration !== null
      && candidate.organicBreadth !== null
    );
    const confidence = confidenceFor(row, cohortScoreable.length);
    const missingEvidence = [...row.missingEvidence];
    if (cohortScoreable.length < MIN_TREND_COHORT_SIZE) {
      missingEvidence.push("peer_cohort");
    }

    const canScoreCurrent = row.starVelocity !== null
      && row.organicBreadth !== null
      && row.eventDiversity !== null
      && row.persistence !== null
      && globallyScoreable.length >= 2;
    const currentComponents: ScoreComponents = {
      star_velocity: canScoreCurrent
        ? percentile(row.starVelocity as number, known(globallyScoreable.map((item) => item.starVelocity)))
        : null,
      peer_relative_growth: null,
      star_acceleration: null,
      actor_acceleration: null,
      organic_breadth: canScoreCurrent
        ? percentile(row.organicBreadth as number, known(globallyScoreable.map((item) => item.organicBreadth)))
        : null,
      event_diversity: canScoreCurrent ? row.eventDiversity : null,
      persistence: canScoreCurrent ? row.persistence : null,
    };
    const canScoreBreakout = cohortScoreable.length >= MIN_TREND_COHORT_SIZE
      && row.relativeGrowth !== null
      && row.starAcceleration !== null
      && row.actorAcceleration !== null
      && row.organicBreadth !== null;
    const breakoutComponents: ScoreComponents = {
      star_velocity: null,
      peer_relative_growth: canScoreBreakout
        ? percentile(row.relativeGrowth as number, known(cohortScoreable.map((item) => item.relativeGrowth)))
        : null,
      star_acceleration: canScoreBreakout
        ? percentile(row.starAcceleration as number, known(cohortScoreable.map((item) => item.starAcceleration)))
        : null,
      actor_acceleration: canScoreBreakout
        ? percentile(row.actorAcceleration as number, known(cohortScoreable.map((item) => item.actorAcceleration)))
        : null,
      organic_breadth: canScoreBreakout
        ? percentile(row.organicBreadth as number, known(cohortScoreable.map((item) => item.organicBreadth)))
        : null,
      event_diversity: null,
      persistence: null,
    };
    const currentScore = scoreFrom(known(Object.values(currentComponents)));
    const breakoutScore = scoreFrom(known(Object.values(breakoutComponents)));
    const phase = phaseFor(currentScore, breakoutScore, row.starAcceleration, confidence);
    const reasons = reasonList(currentComponents, breakoutComponents);

    return {
      ...row.repository,
      topics: [...row.repository.topics],
      metrics: { ...row.repository.metrics },
      official_ranks: { ...row.repository.official_ranks },
      growth: { ...row.repository.growth },
      momentum: {
        ...row.repository.momentum,
        reasons: [...row.repository.momentum.reasons],
        components: { ...row.repository.momentum.components },
      },
      trend_intelligence: {
        score_version: "trend-intelligence-v2-shadow",
        phase,
        confidence,
        current_heat: { score: currentScore, components: currentComponents },
        breakout: { score: breakoutScore, components: breakoutComponents },
        cohort: { key: row.cohortKey, size: cohortScoreable.length },
        event_data_captured_at: row.eventSignals?.captured_at ?? null,
        missing_evidence: [...new Set(missingEvidence)],
        reasons,
      },
    };
  });
}
