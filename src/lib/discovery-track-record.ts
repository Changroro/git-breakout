import {
  normalizeObservationSources,
  type ObservationSource,
} from "./ranking.js";

export type EvidenceCoverage = "complete" | "gap" | "unknown";

export type DiscoveryOutcome =
  | "verified"
  | "pending"
  | "not_converted"
  | "inconclusive"
  | "already_trending"
  | "legacy";

export type DiscoveryEvidence = {
  outcome: DiscoveryOutcome;
  first_observed_at: string | null;
  first_trending_daily_at: string | null;
  first_trending_daily_rank: number | null;
  lead_hours: number | null;
  sources: ObservationSource[] | null;
  coverage: EvidenceCoverage;
};

export type TrackRecordConversion = {
  converted: number;
  eligible: number;
  rate: number | null;
};

export type TrackRecordRecentHit = {
  full_name: string;
  first_observed_at: string;
  first_trending_at: string;
  first_trending_rank: number;
  lead_hours: number;
  sources: ObservationSource[];
  coverage: "complete";
};

export type TrackRecord = {
  schema_version: "1.0";
  evidence_started_at: string | null;
  generated_at: string;
  verified_count: number;
  median_lead_hours: number | null;
  conversion_7d: TrackRecordConversion;
  conversion_14d: TrackRecordConversion;
  period_hits: {
    daily: number;
    weekly: number;
    monthly: number;
  };
  recent_hits: TrackRecordRecentHit[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return value;
}

function parseNullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : requireTimestamp(value, field);
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = requireNonNegativeInteger(value, field);
  if (parsed === 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return parsed;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative number`);
  }
  return value;
}

function parseNullableNonNegativeNumber(value: unknown, field: string): number | null {
  return value === null ? null : requireNonNegativeNumber(value, field);
}

function parseCoverage(value: unknown, field: string): EvidenceCoverage {
  if (value !== "complete" && value !== "gap" && value !== "unknown") {
    throw new TypeError(`${field} must be complete, gap, or unknown`);
  }
  return value;
}

function parseSources(value: unknown, field: string): ObservationSource[] | null {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array or null`);
  }
  if (value.length === 0) {
    throw new TypeError(`${field} must contain at least one source or be null`);
  }
  const sources = value.map((source, index) => {
    if (typeof source !== "string" || source.trim() === "") {
      throw new TypeError(`${field}[${index}] must be a non-empty string`);
    }
    return source;
  });
  if (new Set(sources).size !== sources.length) {
    throw new TypeError(`${field} must not contain duplicates`);
  }
  return normalizeObservationSources(sources, field);
}

function hasEarlyDiscoverySource(sources: readonly ObservationSource[]): boolean {
  return sources.some((source) => (
    source === "github_search_created"
    || source === "github_search_pushed"
    || source === "gh_archive"
  ));
}

function hasOfficialSource(sources: readonly ObservationSource[]): boolean {
  return sources.some((source) => source.startsWith("official_"));
}

function parseConversion(value: unknown, field: string): TrackRecordConversion {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const converted = requireNonNegativeInteger(value.converted, `${field}.converted`);
  const eligible = requireNonNegativeInteger(value.eligible, `${field}.eligible`);
  if (converted > eligible) {
    throw new RangeError(`${field}.converted cannot exceed eligible`);
  }
  if (eligible === 0) {
    if (value.rate !== null) {
      throw new TypeError(`${field}.rate must be null when eligible is zero`);
    }
    return { converted, eligible, rate: null };
  }
  if (typeof value.rate !== "number" || !Number.isFinite(value.rate) || value.rate < 0 || value.rate > 1) {
    throw new TypeError(`${field}.rate must be between zero and one when eligible is positive`);
  }
  return { converted, eligible, rate: value.rate };
}

function parseRecentHit(value: unknown, index: number): TrackRecordRecentHit {
  const field = `track_record.recent_hits[${index}]`;
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  if (typeof value.full_name !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(value.full_name)) {
    throw new TypeError(`${field}.full_name must use owner/name format`);
  }
  const firstObservedAt = requireTimestamp(value.first_observed_at, `${field}.first_observed_at`);
  const firstTrendingAt = requireTimestamp(value.first_trending_at, `${field}.first_trending_at`);
  if (Date.parse(firstTrendingAt) < Date.parse(firstObservedAt)) {
    throw new RangeError(`${field}.first_trending_at cannot precede first_observed_at`);
  }
  const sources = parseSources(value.sources, `${field}.sources`);
  if (sources === null || !hasEarlyDiscoverySource(sources) || hasOfficialSource(sources)) {
    throw new TypeError(`${field}.sources must prove a non-Trending discovery`);
  }
  const coverage = parseCoverage(value.coverage, `${field}.coverage`);
  if (coverage !== "complete") {
    throw new TypeError(`${field}.coverage must be complete`);
  }
  return {
    full_name: value.full_name,
    first_observed_at: firstObservedAt,
    first_trending_at: firstTrendingAt,
    first_trending_rank: requirePositiveInteger(value.first_trending_rank, `${field}.first_trending_rank`),
    lead_hours: requireNonNegativeNumber(value.lead_hours, `${field}.lead_hours`),
    sources,
    coverage,
  };
}

export function parseDiscoveryEvidence(value: unknown, field = "discovery_evidence"): DiscoveryEvidence {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  if (![
    "verified",
    "pending",
    "not_converted",
    "inconclusive",
    "already_trending",
    "legacy",
  ].includes(String(value.outcome))) {
    throw new TypeError(`${field}.outcome is invalid`);
  }
  const firstTrendingAt = parseNullableTimestamp(
    value.first_trending_daily_at,
    `${field}.first_trending_daily_at`,
  );
  const firstTrendingRank = value.first_trending_daily_rank === null
    ? null
    : requirePositiveInteger(value.first_trending_daily_rank, `${field}.first_trending_daily_rank`);
  if ((firstTrendingAt === null) !== (firstTrendingRank === null)) {
    throw new TypeError(`${field} trending timestamp and rank must both be present or null`);
  }
  const leadHours = parseNullableNonNegativeNumber(value.lead_hours, `${field}.lead_hours`);
  const firstObservedAt = parseNullableTimestamp(
    value.first_observed_at,
    `${field}.first_observed_at`,
  );
  const sources = parseSources(value.sources, `${field}.sources`);
  const coverage = parseCoverage(value.coverage, `${field}.coverage`);
  if ((sources === null) !== (coverage === "unknown")) {
    throw new TypeError(`${field}.coverage must be unknown exactly when sources are unknown`);
  }
  if (value.outcome === "verified" && (firstTrendingAt === null || leadHours === null)) {
    throw new TypeError(`${field} verified outcome requires Trending evidence and lead time`);
  }
  if (value.outcome !== "legacy" && firstObservedAt === null) {
    throw new TypeError(`${field} non-legacy outcome requires first_observed_at`);
  }
  if (
    value.outcome === "verified"
    && firstTrendingAt !== null
    && firstObservedAt !== null
    && Date.parse(firstTrendingAt) < Date.parse(firstObservedAt)
  ) {
    throw new RangeError(`${field} verified Trending evidence cannot precede first observation`);
  }
  if (value.outcome === "verified") {
    if (sources === null || !hasEarlyDiscoverySource(sources) || hasOfficialSource(sources)) {
      throw new TypeError(`${field} verified outcome requires non-Trending discovery provenance`);
    }
    if (coverage !== "complete") {
      throw new TypeError(`${field} verified outcome requires complete coverage`);
    }
  }
  if (value.outcome === "pending" || value.outcome === "not_converted") {
    if (firstTrendingAt !== null || leadHours !== null) {
      throw new TypeError(`${field} unconverted outcome cannot include Trending evidence`);
    }
    if (sources === null || !hasEarlyDiscoverySource(sources) || hasOfficialSource(sources)) {
      throw new TypeError(`${field} unconverted outcome requires non-Trending discovery provenance`);
    }
  }
  if (
    (value.outcome === "pending" || value.outcome === "not_converted")
    && coverage !== "complete"
  ) {
    throw new TypeError(`${field} ${String(value.outcome)} outcome requires complete coverage`);
  }
  if (value.outcome === "inconclusive" && coverage !== "gap") {
    throw new TypeError(`${field} inconclusive outcome requires a coverage gap`);
  }
  if (value.outcome === "inconclusive") {
    if (sources === null || !hasEarlyDiscoverySource(sources) || hasOfficialSource(sources)) {
      throw new TypeError(`${field} inconclusive outcome requires non-Trending discovery provenance`);
    }
    if ((firstTrendingAt === null) !== (leadHours === null)) {
      throw new TypeError(`${field} inconclusive Trending evidence and lead time must both be present or null`);
    }
    if (
      firstTrendingAt !== null
      && firstObservedAt !== null
      && Date.parse(firstTrendingAt) < Date.parse(firstObservedAt)
    ) {
      throw new RangeError(`${field} inconclusive Trending evidence cannot precede first observation`);
    }
  }
  if (value.outcome === "already_trending") {
    if (
      firstTrendingAt !== firstObservedAt
      || firstObservedAt === null
      || leadHours !== 0
      || sources === null
      || !sources.includes("official_daily")
    ) {
      throw new TypeError(`${field} already-trending outcome requires first-observation Daily evidence`);
    }
  }
  return {
    outcome: value.outcome as DiscoveryOutcome,
    first_observed_at: firstObservedAt,
    first_trending_daily_at: firstTrendingAt,
    first_trending_daily_rank: firstTrendingRank,
    lead_hours: leadHours,
    sources,
    coverage,
  };
}

export function parseTrackRecord(value: unknown): TrackRecord {
  if (!isRecord(value) || value.schema_version !== "1.0") {
    throw new TypeError("track_record does not match schema version 1.0");
  }
  if (!isRecord(value.period_hits)) {
    throw new TypeError("track_record.period_hits must be an object");
  }
  if (!Array.isArray(value.recent_hits)) {
    throw new TypeError("track_record.recent_hits must be an array");
  }
  if (value.recent_hits.length > 5) {
    throw new RangeError("track_record.recent_hits cannot contain more than five repositories");
  }
  const evidenceStartedAt = parseNullableTimestamp(
    value.evidence_started_at,
    "track_record.evidence_started_at",
  );
  const generatedAt = requireTimestamp(value.generated_at, "track_record.generated_at");
  if (evidenceStartedAt !== null && Date.parse(evidenceStartedAt) > Date.parse(generatedAt)) {
    throw new RangeError("track_record.evidence_started_at cannot follow generated_at");
  }
  const verifiedCount = requireNonNegativeInteger(
    value.verified_count,
    "track_record.verified_count",
  );
  const medianLeadHours = parseNullableNonNegativeNumber(
    value.median_lead_hours,
    "track_record.median_lead_hours",
  );
  const periodHits = {
    daily: requireNonNegativeInteger(value.period_hits.daily, "track_record.period_hits.daily"),
    weekly: requireNonNegativeInteger(value.period_hits.weekly, "track_record.period_hits.weekly"),
    monthly: requireNonNegativeInteger(value.period_hits.monthly, "track_record.period_hits.monthly"),
  };
  const recentHits = value.recent_hits.map(parseRecentHit);
  if ((verifiedCount === 0) !== (medianLeadHours === null)) {
    throw new TypeError("track_record median lead must exist exactly when verified outcomes exist");
  }
  if (periodHits.daily !== verifiedCount) {
    throw new TypeError("track_record Daily hits must equal verified outcomes");
  }
  if (recentHits.length > verifiedCount) {
    throw new RangeError("track_record recent hits cannot exceed verified outcomes");
  }
  return {
    schema_version: "1.0",
    evidence_started_at: evidenceStartedAt,
    generated_at: generatedAt,
    verified_count: verifiedCount,
    median_lead_hours: medianLeadHours,
    conversion_7d: parseConversion(value.conversion_7d, "track_record.conversion_7d"),
    conversion_14d: parseConversion(value.conversion_14d, "track_record.conversion_14d"),
    period_hits: periodHits,
    recent_hits: recentHits,
  };
}
