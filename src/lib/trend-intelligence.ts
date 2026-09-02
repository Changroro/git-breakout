import type { Confidence, RankedRepository } from "./ranking.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const MAX_EVENT_SIGNAL_AGE_HOURS = 4;
export const BREAKOUT_INITIAL_STAR_LIMIT = 10_000;
export const BREAKOUT_BASELINE_DAYS = 7;
export const BREAKOUT_SCORE_THRESHOLD = 70;
export const BREAKOUT_PROVISIONAL_FRACTION = 0.1;

const BREAKOUT_COHORT_KEY = "emerging:global";

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
  coverage: {
    h1: boolean;
    h6: boolean;
    h24: boolean;
    h72: boolean;
  };
  windows: {
    h1: TrendWindowSignals;
    h6: TrendWindowSignals;
    h24: TrendWindowSignals;
    h72: TrendWindowSignals;
  };
};

export type RepositoryBreakoutHistory = {
  full_name: string;
  first_observed_at: string;
  first_observed_stars: number;
  first_observation_was_trending: boolean;
  official_trending_episode_count: number;
  baseline_captured_at: string | null;
  baseline_stars: number | null;
};

type ScoreComponents = {
  star_velocity: number | null;
  peer_relative_growth: number | null;
  self_relative_growth: number | null;
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
  score_version:
    | "trend-intelligence-v2-shadow"
    | "trend-intelligence-v3-shadow"
    | "trend-intelligence-v4-shadow"
    | "trend-intelligence-v5-shadow";
  phase: TrendPhase;
  confidence: Confidence;
  star_evidence_window_hours: 1 | 6 | 24 | null;
  event_evidence_window_hours: 1 | 6 | 24 | null;
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
    || ![
      "trend-intelligence-v2-shadow",
      "trend-intelligence-v3-shadow",
      "trend-intelligence-v4-shadow",
      "trend-intelligence-v5-shadow",
    ].includes(String(value.score_version))
  ) {
    throw new TypeError(`Repository ${repository.full_name} has invalid trend intelligence`);
  }
  return value as TrendIntelligence;
}

type FeatureRow = {
  repository: RankedRepository;
  eventSignals: RepositoryEventSignals | null;
  missingEvidence: string[];
  starEvidenceWindowHours: 1 | 6 | 24 | null;
  eventEvidenceWindowHours: 1 | 6 | 24 | null;
  starVelocity: number | null;
  breakoutStarVelocity: number | null;
  relativeGrowth: number | null;
  selfRelativeGrowth: number | null;
  starAcceleration: number | null;
  actorAcceleration: number | null;
  organicBreadth: number | null;
  eventDiversity: number | null;
  persistence: number | null;
  emergingEligible: boolean;
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

function validateBreakoutHistory(
  history: RepositoryBreakoutHistory,
  capturedAt: number,
): RepositoryBreakoutHistory {
  if (!/^[^/\s]+\/[^/\s]+$/.test(history.full_name)) {
    throw new TypeError("breakout_history.full_name must use owner/name format");
  }
  const firstObservedAt = parseTimestamp(
    history.first_observed_at,
    `breakout_history.${history.full_name}.first_observed_at`,
  );
  if (firstObservedAt >= capturedAt) {
    throw new RangeError(`Breakout history for ${history.full_name} must precede capturedAt`);
  }
  requireNonNegativeInteger(
    history.first_observed_stars,
    `breakout_history.${history.full_name}.first_observed_stars`,
  );
  if (typeof history.first_observation_was_trending !== "boolean") {
    throw new TypeError(
      `breakout_history.${history.full_name}.first_observation_was_trending must be boolean`,
    );
  }
  requireNonNegativeInteger(
    history.official_trending_episode_count,
    `breakout_history.${history.full_name}.official_trending_episode_count`,
  );
  if (
    history.first_observation_was_trending
    && history.official_trending_episode_count === 0
  ) {
    throw new RangeError(`Breakout history for ${history.full_name} has inconsistent Trending evidence`);
  }
  if ((history.baseline_captured_at === null) !== (history.baseline_stars === null)) {
    throw new TypeError(`Breakout baseline for ${history.full_name} must be complete or null`);
  }
  if (history.baseline_captured_at !== null && history.baseline_stars !== null) {
    const baselineCapturedAt = parseTimestamp(
      history.baseline_captured_at,
      `breakout_history.${history.full_name}.baseline_captured_at`,
    );
    requireNonNegativeInteger(
      history.baseline_stars,
      `breakout_history.${history.full_name}.baseline_stars`,
    );
    if (baselineCapturedAt < firstObservedAt || baselineCapturedAt >= capturedAt) {
      throw new RangeError(`Breakout baseline for ${history.full_name} has inconsistent timestamps`);
    }
  }
  return { ...history };
}

function validateWindow(window: TrendWindowSignals, field: string): void {
  Object.entries(window).forEach(([name, value]) => {
    requireNonNegativeInteger(value, `${field}.${name}`);
  });
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
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

function starEvidence(repository: RankedRepository): {
  delta: number;
  hours: 1 | 6 | 24;
} | null {
  if (repository.growth.stars_delta_24h !== null) {
    return { delta: repository.growth.stars_delta_24h, hours: 24 };
  }
  if (repository.growth.stars_delta_6h !== null) {
    return { delta: repository.growth.stars_delta_6h, hours: 6 };
  }
  if (repository.growth.stars_delta_1h !== null) {
    return { delta: repository.growth.stars_delta_1h, hours: 1 };
  }
  return null;
}

function eventEvidenceWindow(signals: RepositoryEventSignals): 1 | 6 | 24 | null {
  if (signals.coverage.h24) return 24;
  if (signals.coverage.h6) return 6;
  if (signals.coverage.h1) return 1;
  return null;
}

function featureRow(
  repository: RankedRepository,
  eventSignals: RepositoryEventSignals | null,
  history: RepositoryBreakoutHistory | null,
  capturedAt: number,
): FeatureRow {
  const missingEvidence: string[] = [];
  const selectedStarEvidence = starEvidence(repository);
  const delta1 = repository.growth.stars_delta_1h;
  const delta6 = repository.growth.stars_delta_6h;
  const delta24 = repository.growth.stars_delta_24h;
  const stars = repository.metrics.stars;
  if (selectedStarEvidence === null) {
    missingEvidence.push("star_growth_window");
  } else if (selectedStarEvidence.hours < 24) {
    missingEvidence.push("star_window_24h");
  }

  let emergingEligible = history !== null;
  if (history === null) {
    missingEvidence.push("emerging_history");
  } else {
    if (history.first_observed_stars >= BREAKOUT_INITIAL_STAR_LIMIT) {
      missingEvidence.push("emerging_initial_stars");
      emergingEligible = false;
    }
    if (history.first_observation_was_trending) {
      missingEvidence.push("emerging_first_observation");
      emergingEligible = false;
    }
    if (history.official_trending_episode_count > 0) {
      missingEvidence.push("emerging_prior_trending");
      emergingEligible = false;
    }
    const baselineCapturedAt = history.baseline_captured_at === null
      ? null
      : parseTimestamp(
        history.baseline_captured_at,
        `breakout_history.${repository.full_name}.baseline_captured_at`,
      );
    if (
      baselineCapturedAt === null
      || history.baseline_stars === null
      || baselineCapturedAt > capturedAt - BREAKOUT_BASELINE_DAYS * DAY_MS
    ) {
      missingEvidence.push("emerging_baseline_7d");
    }
  }

  let freshSignals = eventSignals;
  let selectedEventWindow: 1 | 6 | 24 | null = null;
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
    Object.entries(eventSignals.coverage).forEach(([windowName, covered]) => {
      if (typeof covered !== "boolean") {
        throw new TypeError(`event_signals.${repository.full_name}.coverage.${windowName} must be boolean`);
      }
    });
    if (capturedAt - eventCapturedAt > MAX_EVENT_SIGNAL_AGE_HOURS * HOUR_MS) {
      missingEvidence.push("fresh_github_events");
      freshSignals = null;
    } else {
      selectedEventWindow = eventEvidenceWindow(eventSignals);
      if (selectedEventWindow === null) {
        missingEvidence.push("event_growth_window");
        freshSignals = null;
      } else if (selectedEventWindow < 24) {
        missingEvidence.push("event_window_24h");
      }
    }
  }

  const priorStars = stars === null || selectedStarEvidence === null
    ? null
    : Math.max(stars - selectedStarEvidence.delta, 1);
  const selectedBreakoutEvidence = (selectedStarEvidence?.hours ?? 0) >= 6
    ? selectedStarEvidence
    : null;
  const breakoutStarVelocity = selectedBreakoutEvidence === null
    ? repository.observedStarsPerDay
    : selectedBreakoutEvidence.delta * 24 / selectedBreakoutEvidence.hours;
  const baselineCapturedAt = history?.baseline_captured_at === null
    || history?.baseline_captured_at === undefined
    ? null
    : parseTimestamp(
      history.baseline_captured_at,
      `breakout_history.${repository.full_name}.baseline_captured_at`,
    );
  const priorDayStars = stars === null || delta24 === null
    ? null
    : Math.max(stars - delta24, 0);
  const baselineElapsedDays = baselineCapturedAt === null
    ? null
    : (capturedAt - DAY_MS - baselineCapturedAt) / DAY_MS;
  const previousDailyGrowth = priorDayStars === null
    || history?.baseline_stars === null
    || history?.baseline_stars === undefined
    || baselineElapsedDays === null
    || baselineElapsedDays <= 0
    ? null
    : Math.max(0, priorDayStars - history.baseline_stars) / baselineElapsedDays;
  const starAcceleration = delta6 !== null && delta24 !== null
    ? delta6 / 6 - delta24 / 24
    : delta1 !== null && delta6 !== null
      ? delta1 - delta6 / 6
      : null;
  const selectedSignals = freshSignals === null || selectedEventWindow === null
    ? null
    : freshSignals.windows[`h${selectedEventWindow}`];
  const actorAcceleration = freshSignals === null
    ? null
    : selectedEventWindow === 24
      ? freshSignals.windows.h6.unique_actors / 6 - freshSignals.windows.h24.unique_actors / 24
      : selectedEventWindow === 6
        ? freshSignals.windows.h1.unique_actors - freshSignals.windows.h6.unique_actors / 6
        : null;
  const persistence = freshSignals === null
    ? null
    : selectedEventWindow === 24
      ? Math.min(
        1,
        freshSignals.windows.h6.unique_actors * 4 /
          Math.max(freshSignals.windows.h24.unique_actors, 1),
      )
      : selectedEventWindow === 6
        ? Math.min(
          1,
          freshSignals.windows.h1.unique_actors * 6 /
            Math.max(freshSignals.windows.h6.unique_actors, 1),
        )
        : null;

  return {
    repository,
    eventSignals: freshSignals,
    missingEvidence,
    starEvidenceWindowHours: selectedStarEvidence?.hours ?? null,
    eventEvidenceWindowHours: selectedEventWindow,
    starVelocity: selectedStarEvidence === null
      ? null
      : selectedStarEvidence.delta * 24 / selectedStarEvidence.hours,
    breakoutStarVelocity,
    relativeGrowth: stars === null || breakoutStarVelocity === null
      ? null
      : selectedBreakoutEvidence === null
        ? breakoutStarVelocity / Math.max(stars, 1)
        : priorStars === null
          ? null
          : selectedBreakoutEvidence.delta / priorStars * 24 / selectedBreakoutEvidence.hours,
    selfRelativeGrowth: delta24 === null || previousDailyGrowth === null
      ? null
      : delta24 / Math.max(previousDailyGrowth, 1),
    starAcceleration,
    actorAcceleration,
    organicBreadth: selectedSignals?.unique_actors ?? null,
    eventDiversity: selectedSignals === null ? null : eventDiversity(selectedSignals),
    persistence,
    emergingEligible,
  };
}

function known(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null);
}

function reasonList(current: ScoreComponents, breakout: ScoreComponents): string[] {
  const reasons: string[] = [];
  if ((breakout.peer_relative_growth ?? 0) >= 0.8) reasons.push("peer_growth_outlier");
  if ((breakout.self_relative_growth ?? 0) >= 0.8) reasons.push("self_growth_acceleration");
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
): TrendPhase {
  if (breakoutScore !== null && breakoutScore >= 85 && (starAcceleration ?? 0) > 0) return "breakout";
  if (breakoutScore !== null && breakoutScore >= BREAKOUT_SCORE_THRESHOLD) return "spark";
  if (currentScore === null) return "insufficient_data";
  if (currentScore >= 85) return "hot";
  if (currentScore >= 55 && (starAcceleration ?? 0) < 0) return "cooling";
  return "steady";
}

function confidenceFor(row: FeatureRow, candidatePoolSize: number): Confidence {
  if (
    row.eventSignals === null
    || row.starEvidenceWindowHours !== 24
    || row.selfRelativeGrowth === null
  ) return "low";
  if ((row.eventEvidenceWindowHours ?? 0) < 6) return "low";
  const hasAllStarWindows = row.repository.growth.stars_delta_1h !== null
    && row.repository.growth.stars_delta_6h !== null
    && row.repository.growth.stars_delta_24h !== null;
  if (
    candidatePoolSize >= 20
    && row.starEvidenceWindowHours === 24
    && hasAllStarWindows
    && row.eventEvidenceWindowHours === 24
    && row.eventSignals.windows.h72.unique_actors > 0
  ) {
    return "high";
  }
  return "medium";
}

export function rankTrendIntelligence(
  repositories: readonly RankedRepository[],
  eventSignals: readonly RepositoryEventSignals[],
  capturedAt: string | Date,
  breakoutHistories: readonly RepositoryBreakoutHistory[],
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

  const historiesByName = new Map<string, RepositoryBreakoutHistory>();
  breakoutHistories.forEach((history) => {
    const validated = validateBreakoutHistory(history, capturedTimestamp);
    const key = validated.full_name.toLocaleLowerCase("en-US");
    if (historiesByName.has(key)) {
      throw new Error(`Duplicate breakout history for ${validated.full_name}`);
    }
    historiesByName.set(key, validated);
  });

  const rows = repositories.map((repository) => featureRow(
    repository,
    signalsByName.get(repository.full_name.toLocaleLowerCase("en-US")) ?? null,
    historiesByName.get(repository.full_name.toLocaleLowerCase("en-US")) ?? null,
    capturedTimestamp,
  ));
  const globallyScoreable = rows.filter((row) =>
    row.starVelocity !== null && row.starVelocity > 0 && row.organicBreadth !== null
  );
  const breakoutPool = rows.filter((row) =>
    row.emergingEligible
    && row.breakoutStarVelocity !== null
    && row.breakoutStarVelocity > 0
    && row.relativeGrowth !== null
  );
  const breakoutStarVelocities = known(breakoutPool.map((row) => row.breakoutStarVelocity));
  const breakoutRelativeGrowth = known(breakoutPool.map((row) => row.relativeGrowth));
  const breakoutSelfRelativeGrowth = known(breakoutPool.map((row) => row.selfRelativeGrowth));
  const breakoutStarAccelerations = known(breakoutPool.map((row) => row.starAcceleration));
  const breakoutActorAccelerations = known(breakoutPool.map((row) => row.actorAcceleration));
  const breakoutOrganicBreadth = known(breakoutPool.map((row) => row.organicBreadth));
  const breakoutCalculations = new Map<string, {
    components: ScoreComponents;
    score: number | null;
  }>();

  breakoutPool.forEach((row) => {
    const canCompare = breakoutPool.length >= 2;
    const components: ScoreComponents = {
      star_velocity: canCompare
        ? percentile(row.breakoutStarVelocity as number, breakoutStarVelocities)
        : null,
      peer_relative_growth: canCompare
        ? percentile(row.relativeGrowth as number, breakoutRelativeGrowth)
        : null,
      self_relative_growth: row.selfRelativeGrowth !== null && breakoutSelfRelativeGrowth.length >= 2
        ? percentile(row.selfRelativeGrowth, breakoutSelfRelativeGrowth)
        : null,
      star_acceleration: row.starAcceleration !== null && breakoutStarAccelerations.length >= 2
        ? percentile(row.starAcceleration, breakoutStarAccelerations)
        : null,
      actor_acceleration: row.actorAcceleration !== null && breakoutActorAccelerations.length >= 2
        ? percentile(row.actorAcceleration, breakoutActorAccelerations)
        : null,
      organic_breadth: row.organicBreadth !== null && breakoutOrganicBreadth.length >= 2
        ? percentile(row.organicBreadth, breakoutOrganicBreadth)
        : null,
      event_diversity: null,
      persistence: null,
    };
    breakoutCalculations.set(row.repository.full_name, {
      components,
      score: scoreFrom(known(Object.values(components))),
    });
  });

  const provisionalLimit = Math.ceil(
    breakoutPool.filter((row) => row.repository.growth.stars_delta_24h === null).length
      * BREAKOUT_PROVISIONAL_FRACTION,
  );
  const surfacedProvisional = new Set(
    breakoutPool
      .filter((row) => row.repository.growth.stars_delta_24h === null)
      .map((row) => ({
        fullName: row.repository.full_name,
        score: breakoutCalculations.get(row.repository.full_name)?.score ?? null,
      }))
      .filter((row): row is { fullName: string; score: number } => row.score !== null)
      .sort((left, right) => (
        right.score - left.score
        || left.fullName.localeCompare(right.fullName)
      ))
      .slice(0, provisionalLimit)
      .map((row) => row.fullName),
  );

  return rows.map((row) => {
    const confidence = confidenceFor(row, breakoutPool.length);
    const missingEvidence = [...row.missingEvidence];

    const canScoreCurrent = row.starVelocity !== null
      && row.starVelocity > 0
      && row.organicBreadth !== null
      && row.eventDiversity !== null
      && globallyScoreable.length >= 2;
    const currentComponents: ScoreComponents = {
      star_velocity: canScoreCurrent
        ? percentile(row.starVelocity as number, known(globallyScoreable.map((item) => item.starVelocity)))
        : null,
      peer_relative_growth: null,
      self_relative_growth: null,
      star_acceleration: null,
      actor_acceleration: null,
      organic_breadth: canScoreCurrent
        ? percentile(row.organicBreadth as number, known(globallyScoreable.map((item) => item.organicBreadth)))
        : null,
      event_diversity: canScoreCurrent ? row.eventDiversity : null,
      persistence: canScoreCurrent ? row.persistence : null,
    };
    const calculation = breakoutCalculations.get(row.repository.full_name);
    const breakoutComponents: ScoreComponents = calculation?.components ?? {
      star_velocity: null,
      peer_relative_growth: null,
      self_relative_growth: null,
      star_acceleration: null,
      actor_acceleration: null,
      organic_breadth: null,
      event_diversity: null,
      persistence: null,
    };
    const currentScore = scoreFrom(known(Object.values(currentComponents)));
    const calculatedBreakoutScore = calculation?.score ?? null;
    const breakoutScore = calculatedBreakoutScore !== null && (
      row.repository.growth.stars_delta_24h !== null
        ? calculatedBreakoutScore >= BREAKOUT_SCORE_THRESHOLD
        : surfacedProvisional.has(row.repository.full_name)
    ) ? calculatedBreakoutScore : null;
    const phase = phaseFor(currentScore, breakoutScore, row.starAcceleration);
    const reasons = reasonList(currentComponents, breakoutComponents);

    return {
      ...row.repository,
      topics: [...row.repository.topics],
      observation_sources: row.repository.observation_sources === null
        ? null
        : [...row.repository.observation_sources],
      metrics: { ...row.repository.metrics },
      official_ranks: { ...row.repository.official_ranks },
      growth: { ...row.repository.growth },
      momentum: {
        ...row.repository.momentum,
        reasons: [...row.repository.momentum.reasons],
        components: { ...row.repository.momentum.components },
      },
      trend_intelligence: {
        score_version: "trend-intelligence-v5-shadow",
        phase,
        confidence,
        star_evidence_window_hours: row.starEvidenceWindowHours,
        event_evidence_window_hours: row.eventEvidenceWindowHours,
        current_heat: { score: currentScore, components: currentComponents },
        breakout: { score: breakoutScore, components: breakoutComponents },
        cohort: { key: BREAKOUT_COHORT_KEY, size: breakoutPool.length },
        event_data_captured_at: row.eventSignals?.captured_at ?? null,
        missing_evidence: [...new Set(missingEvidence)],
        reasons,
      },
    };
  });
}
