import type { Confidence, RankedRepository } from "./ranking.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const MAX_EVENT_SIGNAL_AGE_HOURS = 4;
/** Completed weeks of GitHub star history compared against the recent day. */
export const BREAKOUT_HISTORY_WEEKS = 12;
/** Minimum completed weeks required before a self-relative baseline exists. */
export const BREAKOUT_HISTORY_MIN_WEEKS = 2;
export const BREAKOUT_SCORE_THRESHOLD = 70;
export const BREAKOUT_PROVISIONAL_FRACTION = 0.1;

const BREAKOUT_COHORT_KEY = "breakout:global";
/** A completed history day older than this is too stale to stand in for a 24-hour window. */
const HISTORY_DAY_MAX_AGE_MS = 36 * HOUR_MS;
/** Day boundaries reported by GitHub are matched with this tolerance. */
const HISTORY_DAY_TOLERANCE_MS = 2 * HOUR_MS;

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

export type StarHistoryPoint = {
  /** End of a completed GitHub star history day. */
  captured_at: string;
  stars: number;
};

/**
 * Exact star counts at the end of completed days, derived from the GitHub
 * star history endpoint anchored to the repository's current count.
 */
export type RepositoryStarHistory = {
  full_name: string;
  /** Moment the history was anchored; every point precedes it. */
  captured_at: string;
  /** Ascending, at most one point per day. */
  day_ends: StarHistoryPoint[];
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
    | "trend-intelligence-v5-shadow"
    | "trend-intelligence-v6-shadow";
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
      "trend-intelligence-v6-shadow",
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
};

type HistoryFeatures = {
  /** Stars gained during the most recent completed day. */
  dailyGain: number | null;
  /** Stars at the start of that day. */
  dailyGainStartStars: number | null;
  /** Median daily growth over the completed weeks before the recent window. */
  priorDailyGrowth: number | null;
  priorWeeks: number;
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

function validateStarHistory(
  history: RepositoryStarHistory,
  capturedAt: number,
): RepositoryStarHistory {
  if (!/^[^/\s]+\/[^/\s]+$/.test(history.full_name)) {
    throw new TypeError("star_history.full_name must use owner/name format");
  }
  const anchoredAt = parseTimestamp(
    history.captured_at,
    `star_history.${history.full_name}.captured_at`,
  );
  if (anchoredAt > capturedAt) {
    throw new RangeError(`Star history for ${history.full_name} cannot be anchored after capturedAt`);
  }
  if (!Array.isArray(history.day_ends)) {
    throw new TypeError(`star_history.${history.full_name}.day_ends must be an array`);
  }
  let previous = Number.NEGATIVE_INFINITY;
  const dayEnds = history.day_ends.map((point, index) => {
    const timestamp = parseTimestamp(
      point.captured_at,
      `star_history.${history.full_name}.day_ends[${index}].captured_at`,
    );
    requireNonNegativeInteger(point.stars, `star_history.${history.full_name}.day_ends[${index}].stars`);
    if (timestamp <= previous || timestamp > anchoredAt) {
      throw new RangeError(`Star history for ${history.full_name} must list completed days in ascending order`);
    }
    previous = timestamp;
    return { captured_at: point.captured_at, stars: point.stars };
  });
  return { full_name: history.full_name, captured_at: history.captured_at, day_ends: dayEnds };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function latestPointAtOrBefore(
  points: readonly StarHistoryPoint[],
  timestamp: number,
): StarHistoryPoint | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (Date.parse(points[index].captured_at) <= timestamp) {
      return points[index];
    }
  }
  return null;
}

function pointNear(points: readonly StarHistoryPoint[], timestamp: number): StarHistoryPoint | null {
  let best: StarHistoryPoint | null = null;
  let bestDistance = HISTORY_DAY_TOLERANCE_MS;
  points.forEach((point) => {
    const distance = Math.abs(Date.parse(point.captured_at) - timestamp);
    if (distance <= bestDistance) {
      best = point;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * Derives the recent completed day and the repository's own growth
 * baseline from GitHub star history. `recentWindowStart` is the moment the
 * recent evidence begins; prior weeks end at or before it so the baseline
 * never overlaps the growth it is compared against.
 */
function historyFeatures(
  history: RepositoryStarHistory | null,
  capturedAt: number,
  observedDelta24: number | null,
): HistoryFeatures {
  const empty: HistoryFeatures = {
    dailyGain: null,
    dailyGainStartStars: null,
    priorDailyGrowth: null,
    priorWeeks: 0,
  };
  if (history === null) return empty;
  const points = history.day_ends;
  const latest = latestPointAtOrBefore(points, capturedAt);
  const latestTimestamp = latest === null ? null : Date.parse(latest.captured_at);
  const dayBefore = latestTimestamp === null ? null : pointNear(points, latestTimestamp - DAY_MS);
  const recentDayUsable = latest !== null
    && latestTimestamp !== null
    && dayBefore !== null
    && capturedAt - latestTimestamp <= HISTORY_DAY_MAX_AGE_MS;
  const dailyGain = recentDayUsable ? Math.max(0, latest.stars - dayBefore.stars) : null;
  const dailyGainStartStars = recentDayUsable ? dayBefore.stars : null;

  const recentWindowStart = observedDelta24 !== null
    ? capturedAt - DAY_MS
    : recentDayUsable
      ? latestTimestamp - DAY_MS
      : null;
  const anchor = recentWindowStart === null ? null : latestPointAtOrBefore(points, recentWindowStart);
  const weeklyGains: number[] = [];
  if (anchor !== null) {
    const anchorTimestamp = Date.parse(anchor.captured_at);
    for (let week = 1; week <= BREAKOUT_HISTORY_WEEKS; week += 1) {
      const end = pointNear(points, anchorTimestamp - (week - 1) * 7 * DAY_MS);
      const start = pointNear(points, anchorTimestamp - week * 7 * DAY_MS);
      if (end === null || start === null) break;
      weeklyGains.push(Math.max(0, end.stars - start.stars));
    }
  }
  return {
    dailyGain,
    dailyGainStartStars,
    priorDailyGrowth: weeklyGains.length >= BREAKOUT_HISTORY_MIN_WEEKS ? median(weeklyGains) / 7 : null,
    priorWeeks: weeklyGains.length,
  };
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
  history: RepositoryStarHistory | null,
  capturedAt: number,
): FeatureRow {
  const missingEvidence: string[] = [];
  const selectedStarEvidence = starEvidence(repository);
  const delta1 = repository.growth.stars_delta_1h;
  const delta6 = repository.growth.stars_delta_6h;
  const delta24 = repository.growth.stars_delta_24h;
  const stars = repository.metrics.stars;
  const historyEvidence = historyFeatures(history, capturedAt, delta24);
  if (selectedStarEvidence === null) {
    missingEvidence.push(historyEvidence.dailyGain === null ? "star_growth_window" : "star_window_observed");
  } else if (selectedStarEvidence.hours < 24) {
    missingEvidence.push("star_window_24h");
  }
  if (history === null) {
    missingEvidence.push("star_history");
  } else if (historyEvidence.priorDailyGrowth === null) {
    missingEvidence.push("star_history_baseline");
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
  // Exact observed windows of at least six hours come first. Without one,
  // GitHub's most recent completed day is an exact 24-hour measurement and
  // outranks the shorter observed velocity.
  const breakoutStarVelocity = selectedBreakoutEvidence !== null
    ? selectedBreakoutEvidence.delta * 24 / selectedBreakoutEvidence.hours
    : historyEvidence.dailyGain !== null
      ? historyEvidence.dailyGain
      : repository.observedStarsPerDay;
  const recentDailyGrowth = delta24 ?? historyEvidence.dailyGain;
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
      : selectedBreakoutEvidence !== null
        ? priorStars === null
          ? null
          : selectedBreakoutEvidence.delta / priorStars * 24 / selectedBreakoutEvidence.hours
        : historyEvidence.dailyGain !== null && historyEvidence.dailyGainStartStars !== null
          ? historyEvidence.dailyGain / Math.max(historyEvidence.dailyGainStartStars, 1)
          : breakoutStarVelocity / Math.max(stars, 1),
    selfRelativeGrowth: recentDailyGrowth === null || historyEvidence.priorDailyGrowth === null
      ? null
      : recentDailyGrowth / Math.max(historyEvidence.priorDailyGrowth, 1),
    starAcceleration,
    actorAcceleration,
    organicBreadth: selectedSignals?.unique_actors ?? null,
    eventDiversity: selectedSignals === null ? null : eventDiversity(selectedSignals),
    persistence,
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
  starHistories: readonly RepositoryStarHistory[],
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

  const historiesByName = new Map<string, RepositoryStarHistory>();
  starHistories.forEach((history) => {
    const validated = validateStarHistory(history, capturedTimestamp);
    const key = validated.full_name.toLocaleLowerCase("en-US");
    if (historiesByName.has(key)) {
      throw new Error(`Duplicate star history for ${validated.full_name}`);
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
    row.breakoutStarVelocity !== null
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
        score_version: "trend-intelligence-v6-shadow",
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
