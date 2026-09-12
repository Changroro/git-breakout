import { classifyDiscovery, type DiscoveryClassification, type RepositoryDiscoveryHistory } from "./discovery-classification.js";
import { percentileRanks } from "./percentile.js";
import type { Confidence, RankedRepository } from "./ranking.js";

const HOUR_MS = 3_600_000;

export const MAX_EVENT_SIGNAL_AGE_HOURS = 4;
/** Completed weeks of GitHub star history compared against the recent day. */
export const BREAKOUT_HISTORY_WEEKS = 12;
/** Minimum completed weeks required before a self-relative baseline exists. */
export const BREAKOUT_HISTORY_MIN_WEEKS = 2;
export const BREAKOUT_SCORE_THRESHOLD = 70;
export const BREAKOUT_PROVISIONAL_FRACTION = 0.1;

/** A completed history day older than this is too stale to stand in for a 24-hour window. */
const HISTORY_DAY_MAX_AGE_MS = 36 * HOUR_MS;

export type TrendPhase =
  | "resurgence"
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

export type StarHistoryDay = {
  /** Start label derived from GitHub's returned week and day position. */
  start: string;
  /** End label for the derived bucket. */
  end: string;
  /** Stars created that day and still present when the history was fetched. */
  retained_stars_added: number;
};

export type RepositoryStarHistory = {
  full_name: string;
  /** Moment the history was fetched; every retained day ends before it. */
  captured_at: string;
  /** Ascending GitHub day buckets for currently retained stars. */
  days: StarHistoryDay[];
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
    | "trend-intelligence-v6-shadow"
    | "trend-intelligence-v7-shadow"
    | "trend-intelligence-v8-shadow";
  phase: TrendPhase;
  confidence: Confidence;
  star_evidence_window_hours: 1 | 6 | 24 | null;
  event_evidence_window_hours: 1 | 6 | 24 | null;
  current_heat: TrendScore;
  breakout: TrendScore;
  resurgence?: TrendScore;
  classification?: DiscoveryClassification;
  cohort: {
    key: string;
    size: number;
  };
  event_data_captured_at: string | null;
  missing_evidence: string[];
  reasons: string[];
  evidence?: {
    current_heat_component_count: number;
    discovery_component_count: number;
    star_window_elapsed_hours: number | null;
    history_fetched_at: string | null;
    baseline_started_at: string | null;
    baseline_ended_at: string | null;
    baseline_gap_hours: number | null;
  };
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
      "trend-intelligence-v7-shadow",
      "trend-intelligence-v8-shadow",
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
  classification: DiscoveryClassification;
  evidence: Omit<NonNullable<TrendIntelligence["evidence"]>, "current_heat_component_count" | "discovery_component_count">;
};

type HistoryFeatures = {
  /** Stars gained during the most recent completed day. */
  dailyGain: number | null;
  /** Median daily growth over the completed weeks before the recent window. */
  priorDailyGrowth: number | null;
  priorWeeks: number;
  baselineStartedAt: string | null;
  baselineEndedAt: string | null;
  baselineGapHours: number | null;
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
  if (!Array.isArray(history.days)) {
    throw new TypeError(`star_history.${history.full_name}.days must be an array`);
  }
  let previousEnd = Number.NEGATIVE_INFINITY;
  const days = history.days.map((day, index) => {
    const start = parseTimestamp(day.start, `star_history.${history.full_name}.days[${index}].start`);
    const end = parseTimestamp(day.end, `star_history.${history.full_name}.days[${index}].end`);
    requireNonNegativeInteger(
      day.retained_stars_added,
      `star_history.${history.full_name}.days[${index}].retained_stars_added`,
    );
    if (end <= start || end > anchoredAt || (index > 0 && start !== previousEnd)) {
      throw new RangeError(`Star history for ${history.full_name} must list contiguous completed days in ascending order`);
    }
    previousEnd = end;
    return { start: day.start, end: day.end, retained_stars_added: day.retained_stars_added };
  });
  return { full_name: history.full_name, captured_at: history.captured_at, days };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
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
  observedWindowStart: number | null,
): HistoryFeatures {
  const empty: HistoryFeatures = {
    dailyGain: null,
    priorDailyGrowth: null,
    priorWeeks: 0,
    baselineStartedAt: null,
    baselineEndedAt: null,
    baselineGapHours: null,
  };
  if (history === null) return empty;
  const days = history.days;
  const latest = days.at(-1) ?? null;
  const latestEnd = latest === null ? null : Date.parse(latest.end);
  const recentDayUsable = latest !== null
    && latestEnd !== null
    && capturedAt - latestEnd <= HISTORY_DAY_MAX_AGE_MS;
  const dailyGain = recentDayUsable ? latest.retained_stars_added : null;

  const recentWindowStart = observedWindowStart !== null
    ? observedWindowStart
    : recentDayUsable
      ? Date.parse(latest.start)
      : null;
  let anchorIndex = -1;
  if (recentWindowStart !== null) {
    for (let index = days.length - 1; index >= 0; index -= 1) {
      if (Date.parse(days[index].end) <= recentWindowStart) {
        anchorIndex = index;
        break;
      }
    }
  }
  const weeklyGains: number[] = [];
  for (let week = 0; week < BREAKOUT_HISTORY_WEEKS; week += 1) {
    const endIndex = anchorIndex - week * 7;
    const startIndex = endIndex - 6;
    if (startIndex < 0) break;
    weeklyGains.push(days
      .slice(startIndex, endIndex + 1)
      .reduce((sum, day) => sum + day.retained_stars_added, 0));
  }
  return {
    dailyGain,
    priorDailyGrowth: weeklyGains.length >= BREAKOUT_HISTORY_MIN_WEEKS ? median(weeklyGains) / 7 : null,
    priorWeeks: weeklyGains.length,
    baselineStartedAt: weeklyGains.length >= BREAKOUT_HISTORY_MIN_WEEKS
      ? days[anchorIndex - weeklyGains.length * 7 + 1].start : null,
    baselineEndedAt: weeklyGains.length >= BREAKOUT_HISTORY_MIN_WEEKS ? days[anchorIndex].end : null,
    baselineGapHours: weeklyGains.length >= BREAKOUT_HISTORY_MIN_WEEKS && recentWindowStart !== null
      ? (recentWindowStart - Date.parse(days[anchorIndex].end)) / HOUR_MS : null,
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
  elapsedHours: number;
} | null {
  if (repository.growth.stars_delta_24h !== null) {
    return { delta: repository.growth.stars_delta_24h, hours: 24, elapsedHours: observedHours(repository, 24) };
  }
  if (repository.growth.stars_delta_6h !== null) {
    return { delta: repository.growth.stars_delta_6h, hours: 6, elapsedHours: observedHours(repository, 6) };
  }
  if (repository.growth.stars_delta_1h !== null) {
    return { delta: repository.growth.stars_delta_1h, hours: 1, elapsedHours: observedHours(repository, 1) };
  }
  return null;
}

function observedHours(repository: RankedRepository, hours: 1 | 6 | 24): number {
  return repository.growth_evidence?.[`h${hours}`]?.elapsed_hours ?? hours;
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
  origin: RepositoryDiscoveryHistory | null,
): FeatureRow {
  const missingEvidence: string[] = [];
  const selectedStarEvidence = starEvidence(repository);
  const delta1 = repository.growth.stars_delta_1h;
  const delta6 = repository.growth.stars_delta_6h;
  const delta24 = repository.growth.stars_delta_24h;
  const stars = repository.metrics.stars;
  const historyEvidence = historyFeatures(history, capturedAt,
    delta24 === null ? null : capturedAt - observedHours(repository, 24) * HOUR_MS);
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
  // Observed windows come first; otherwise use GitHub's latest retained-star day.
  const breakoutStarVelocity = selectedBreakoutEvidence !== null
    ? selectedBreakoutEvidence.delta * 24 / selectedBreakoutEvidence.elapsedHours
    : historyEvidence.dailyGain !== null
      ? historyEvidence.dailyGain
      : repository.observedStarsPerDay;
  const recentDailyGrowth = delta24 === null ? historyEvidence.dailyGain : delta24 * 24 / observedHours(repository, 24);
  const starAcceleration = delta6 !== null && delta24 !== null
    ? delta6 / observedHours(repository, 6) - delta24 / observedHours(repository, 24)
    : delta1 !== null && delta6 !== null
      ? delta1 / observedHours(repository, 1) - delta6 / observedHours(repository, 6)
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
    classification: classifyDiscovery(repository, origin, history, new Date(capturedAt).toISOString()),
    evidence: {
      star_window_elapsed_hours: selectedStarEvidence?.elapsedHours ?? null,
      history_fetched_at: history?.captured_at ?? null,
      baseline_started_at: historyEvidence.baselineStartedAt,
      baseline_ended_at: historyEvidence.baselineEndedAt,
      baseline_gap_hours: historyEvidence.baselineGapHours,
    },
    eventSignals: freshSignals,
    missingEvidence,
    starEvidenceWindowHours: selectedStarEvidence?.hours ?? null,
    eventEvidenceWindowHours: selectedEventWindow,
    starVelocity: selectedStarEvidence === null
      ? null
      : selectedStarEvidence.delta * 24 / selectedStarEvidence.elapsedHours,
    breakoutStarVelocity,
    relativeGrowth: stars === null || breakoutStarVelocity === null
      ? null
      : selectedBreakoutEvidence !== null
        ? priorStars === null
          ? null
          : selectedBreakoutEvidence.delta / priorStars * 24 / selectedBreakoutEvidence.elapsedHours
        : historyEvidence.dailyGain !== null
          ? historyEvidence.dailyGain / Math.max(stars, 1)
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
  if ((current.organic_breadth ?? 0) >= 0.8) reasons.push("broad_actor_interest");
  if ((current.event_diversity ?? 0) >= 0.75) reasons.push("multi_signal_activity");
  if ((current.persistence ?? 0) >= 0.8) reasons.push("recent_actor_activity");
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
  discoveryHistories: readonly RepositoryDiscoveryHistory[],
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

  const origins = new Map<string, RepositoryDiscoveryHistory>();
  for (const origin of discoveryHistories) {
    const key = origin.full_name.toLowerCase();
    if (origins.has(key)) throw new Error(`Duplicate discovery history for ${origin.full_name}`);
    origins.set(key, origin);
  }
  const rows = repositories.map((repository) => featureRow(
    repository,
    signalsByName.get(repository.full_name.toLocaleLowerCase("en-US")) ?? null,
    historiesByName.get(repository.full_name.toLocaleLowerCase("en-US")) ?? null,
    capturedTimestamp,
    origins.get(repository.full_name.toLowerCase()) ?? null,
  ));
  const globallyScoreable = rows.filter((row) =>
    row.starVelocity !== null && row.starVelocity > 0 && row.organicBreadth !== null
  );
  const currentVelocityRanks = percentileRanks(known(globallyScoreable.map(row => row.starVelocity)));
  const currentBreadthRanks = percentileRanks(known(globallyScoreable.map(row => row.organicBreadth)));
  const breakoutCalculations = new Map<string, {
    components: ScoreComponents;
    score: number | null;
  }>();
  const surfacedProvisional = new Set<string>();
  const cohortSizes = new Map<string, number>();
  for (const category of ["discovery", "resurgence"] as const) {
    const breakoutPool = rows.filter((row) =>
      row.classification.category === category &&
      row.breakoutStarVelocity !== null
      && row.breakoutStarVelocity > 0
      && row.relativeGrowth !== null
    );
    const breakoutStarVelocities = known(breakoutPool.map((row) => row.breakoutStarVelocity));
    const breakoutStarVelocitiesRanks = percentileRanks(breakoutStarVelocities);
    const breakoutRelativeGrowth = known(breakoutPool.map((row) => row.relativeGrowth));
    const breakoutRelativeGrowthRanks = percentileRanks(breakoutRelativeGrowth);
    const breakoutSelfRelativeGrowth = known(breakoutPool.map((row) => row.selfRelativeGrowth));
    const breakoutSelfRelativeGrowthRanks = percentileRanks(breakoutSelfRelativeGrowth);
    const breakoutStarAccelerations = known(breakoutPool.map((row) => row.starAcceleration));
    const breakoutStarAccelerationsRanks = percentileRanks(breakoutStarAccelerations);
    const breakoutActorAccelerations = known(breakoutPool.map((row) => row.actorAcceleration));
    const breakoutActorAccelerationsRanks = percentileRanks(breakoutActorAccelerations);
    const breakoutOrganicBreadth = known(breakoutPool.map((row) => row.organicBreadth));
    const breakoutOrganicBreadthRanks = percentileRanks(breakoutOrganicBreadth);


    breakoutPool.forEach((row) => {
      const canCompare = breakoutPool.length >= 2;
      const components: ScoreComponents = {
        star_velocity: canCompare
          ? breakoutStarVelocitiesRanks.get(row.breakoutStarVelocity as number)!
          : null,
        peer_relative_growth: canCompare
          ? breakoutRelativeGrowthRanks.get(row.relativeGrowth as number)!
          : null,
        self_relative_growth: row.selfRelativeGrowth !== null && breakoutSelfRelativeGrowth.length >= 2
          ? breakoutSelfRelativeGrowthRanks.get(row.selfRelativeGrowth)!
          : null,
        star_acceleration: row.starAcceleration !== null && breakoutStarAccelerations.length >= 2
          ? breakoutStarAccelerationsRanks.get(row.starAcceleration)!
          : null,
        actor_acceleration: row.actorAcceleration !== null && breakoutActorAccelerations.length >= 2
          ? breakoutActorAccelerationsRanks.get(row.actorAcceleration)!
          : null,
        organic_breadth: row.organicBreadth !== null && breakoutOrganicBreadth.length >= 2
          ? breakoutOrganicBreadthRanks.get(row.organicBreadth)!
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
    const provisional = new Set(
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

    for (const name of provisional) surfacedProvisional.add(name);
    cohortSizes.set(category, breakoutPool.length);
  }

  return rows.map((row) => {
    const cohortSize = cohortSizes.get(row.classification.category ?? "") ?? 0;
    const confidence = confidenceFor(row, cohortSize);
    const missingEvidence = [...row.missingEvidence];
    if (row.classification.category !== null && cohortSize < 2) missingEvidence.push("comparison_cohort");
    if (!origins.has(row.repository.full_name.toLowerCase())) missingEvidence.push("discovery_history");

    const canScoreCurrent = row.starVelocity !== null
      && row.starVelocity > 0
      && row.organicBreadth !== null
      && row.eventDiversity !== null
      && globallyScoreable.length >= 2;
    const currentComponents: ScoreComponents = {
      star_velocity: canScoreCurrent
        ? currentVelocityRanks.get(row.starVelocity as number)!
        : null,
      peer_relative_growth: null,
      self_relative_growth: null,
      star_acceleration: null,
      actor_acceleration: null,
      organic_breadth: canScoreCurrent
        ? currentBreadthRanks.get(row.organicBreadth as number)!
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
    const phase = row.classification.category === "resurgence" && breakoutScore !== null
      ? "resurgence" : phaseFor(currentScore, breakoutScore, row.starAcceleration);
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
      ...(row.repository.growth_evidence === undefined ? {} : { growth_evidence: structuredClone(row.repository.growth_evidence) }),
      momentum: {
        ...row.repository.momentum,
        reasons: [...row.repository.momentum.reasons],
        components: { ...row.repository.momentum.components },
      },
      trend_intelligence: {
        score_version: "trend-intelligence-v8-shadow",
        phase,
        confidence,
        star_evidence_window_hours: row.starEvidenceWindowHours,
        event_evidence_window_hours: row.eventEvidenceWindowHours,
        current_heat: { score: currentScore, components: currentComponents },
        breakout: { score: row.classification.category === "discovery" ? breakoutScore : null, components: breakoutComponents },
        resurgence: { score: row.classification.category === "resurgence" ? breakoutScore : null, components: breakoutComponents },
        classification: row.classification,
        cohort: { key: row.classification.category ?? "unclassified", size: cohortSize },
        event_data_captured_at: row.eventSignals?.captured_at ?? null,
        missing_evidence: [...new Set(missingEvidence)],
        reasons,
        evidence: {
          ...row.evidence,
          current_heat_component_count: known(Object.values(currentComponents)).length,
          discovery_component_count: known(Object.values(breakoutComponents)).length,
        },
      },
    };
  });
}
