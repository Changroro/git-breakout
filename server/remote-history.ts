import type { RankedRepository } from "../src/lib/ranking.ts";
import type {
  RepositoryEventSignals,
  TrendRankedRepository,
  TrendWindowSignals,
} from "../src/lib/trend-intelligence.ts";
import type { GhArchiveRepositoryBucket } from "./gh-archive.ts";
import type { EventHourMetadata } from './event-catchup.ts';
import type { StarObservation } from "./history.ts";
import type {
  RepositoryRetentionCandidate,
  RetentionPolicy,
} from "./retention.ts";

export type CollectionContext = {
  latestCapturedAt: string | null;
  intervalMinutes: number;
  retentionPolicy: RetentionPolicy;
  repositories: Array<RepositoryRetentionCandidate & {
    repositoryId?: string;
    identityStatus?: 'verified' | 'legacy_unverified';
    firstObservedStars: number;
    firstObservationWasTrending: boolean;
    officialTrendingEpisodeCount: number;
    growthComparisonCapturedAt: string | null;
    observations: StarObservation[];
  }>;
};

export type CollectionSchedule = {
  nextDueAt: string;
};

export type CollectionRun = { id: string; status: 'running' | 'completed' | 'failed'; startedAt: string; finishedAt: string | null; errorMessage: string | null };
export type RepositoryIdentityRequest = { repository_id: string; full_name: string; requested_names: string[] };

export type SnapshotTimelineEntry = {
  id: string;
  capturedAt: string;
  source: string;
  repositoryCount: number;
};

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return value;
}

function requireFullName(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(value)) {
    throw new TypeError(`${field} must use owner/name format`);
  }
  return value;
}

function requireUuid(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new TypeError(`${field} must use UUID format`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${field} must be a positive integer`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be boolean`);
  }
  return value;
}

export function parseCollectionSchedule(value: unknown): CollectionSchedule {
  const schedule = requireRecord(value, "Collection schedule");
  return {
    nextDueAt: requireTimestamp(schedule.next_due_at, "Collection schedule.next_due_at"),
  };
}

export function millisecondsUntilCollectionDue(
  schedule: CollectionSchedule,
  currentTime: Date,
): number {
  if (!Number.isFinite(currentTime.getTime())) {
    throw new TypeError("Collection schedule current time must be valid");
  }
  return Math.max(0, Date.parse(schedule.nextDueAt) - currentTime.getTime());
}

function parseEventWindow(value: unknown, field: string): TrendWindowSignals {
  const window = requireRecord(value, field);
  return {
    watches: requireNonNegativeInteger(window.watches, `${field}.watches`),
    forks: requireNonNegativeInteger(window.forks, `${field}.forks`),
    pull_requests: requireNonNegativeInteger(window.pull_requests, `${field}.pull_requests`),
    issues: requireNonNegativeInteger(window.issues, `${field}.issues`),
    issue_comments: requireNonNegativeInteger(window.issue_comments, `${field}.issue_comments`),
    pushes: requireNonNegativeInteger(window.pushes, `${field}.pushes`),
    releases: requireNonNegativeInteger(window.releases, `${field}.releases`),
    unique_actors: requireNonNegativeInteger(window.unique_actors, `${field}.unique_actors`),
  };
}

export function parseEventSignalContext(value: unknown): RepositoryEventSignals[] {
  const context = requireRecord(value, "Event signal context");
  if (!Array.isArray(context.repositories)) {
    throw new TypeError("Event signal context.repositories must be an array");
  }
  const coverageValue = requireRecord(context.coverage, "Event signal context.coverage");
  const coverage = {
    h1: requireBoolean(coverageValue.h1, "Event signal context.coverage.h1"),
    h6: requireBoolean(coverageValue.h6, "Event signal context.coverage.h6"),
    h24: requireBoolean(coverageValue.h24, "Event signal context.coverage.h24"),
    h72: requireBoolean(coverageValue.h72, "Event signal context.coverage.h72"),
  };
  if (context.captured_at === null) {
    if (context.repositories.length > 0) {
      throw new TypeError("Event signal context cannot contain repositories without captured_at");
    }
    if (Object.values(coverage).some(Boolean)) {
      throw new TypeError("Empty event signal context cannot report covered windows");
    }
    return [];
  }
  const capturedAt = requireTimestamp(context.captured_at, "Event signal context.captured_at");
  const seen = new Set<string>();
  return context.repositories.map((repositoryValue, index) => {
    const repository = requireRecord(repositoryValue, `Event signal context.repositories[${index}]`);
    const fullName = requireFullName(
      repository.full_name,
      `Event signal context.repositories[${index}].full_name`,
    );
    const key = fullName.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      throw new Error(`Event signal context contains duplicate repository ${fullName}`);
    }
    seen.add(key);
    const windows = requireRecord(
      repository.windows,
      `Event signal context.repositories[${index}].windows`,
    );
    const repositoryCoverage = requireRecord(repository.coverage, `Event signal context.repositories[${index}].coverage`);
    return {
      full_name: fullName,
      captured_at: capturedAt,
      coverage: {
        h1: requireBoolean(repositoryCoverage.h1, 'Repository coverage.h1') && coverage.h1,
        h6: requireBoolean(repositoryCoverage.h6, 'Repository coverage.h6') && coverage.h6,
        h24: requireBoolean(repositoryCoverage.h24, 'Repository coverage.h24') && coverage.h24,
        h72: requireBoolean(repositoryCoverage.h72, 'Repository coverage.h72') && coverage.h72,
      },
      windows: {
        h1: parseEventWindow(windows.h1, `Event signal context.repositories[${index}].windows.h1`),
        h6: parseEventWindow(windows.h6, `Event signal context.repositories[${index}].windows.h6`),
        h24: parseEventWindow(windows.h24, `Event signal context.repositories[${index}].windows.h24`),
        h72: parseEventWindow(windows.h72, `Event signal context.repositories[${index}].windows.h72`),
      },
    };
  });
}

export function parseSnapshotTimeline(value: unknown): SnapshotTimelineEntry[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Snapshot timeline must be an array");
  }
  const seenIds = new Set<string>();
  const seenTimestamps = new Set<string>();
  return value.map((snapshotValue, index) => {
    const snapshot = requireRecord(snapshotValue, `Snapshot timeline[${index}]`);
    const id = requireUuid(snapshot.id, `Snapshot timeline[${index}].id`);
    const capturedAt = requireTimestamp(
      snapshot.captured_at,
      `Snapshot timeline[${index}].captured_at`,
    );
    if (seenIds.has(id) || seenTimestamps.has(capturedAt)) {
      throw new Error(`Snapshot timeline contains duplicate snapshot ${id}`);
    }
    seenIds.add(id);
    seenTimestamps.add(capturedAt);
    if (typeof snapshot.source !== "string" || snapshot.source.trim() === "") {
      throw new TypeError(`Snapshot timeline[${index}].source is required`);
    }
    if (!Number.isInteger(snapshot.repository_count) || (snapshot.repository_count as number) <= 0) {
      throw new RangeError(`Snapshot timeline[${index}].repository_count must be a positive integer`);
    }
    return {
      id,
      capturedAt,
      source: snapshot.source,
      repositoryCount: snapshot.repository_count as number,
    };
  });
}

export function parseCollectionContext(value: unknown): CollectionContext {
  const context = requireRecord(value, "Collection context");
  const latestCapturedAt = context.latest_captured_at === null
    ? null
    : requireTimestamp(context.latest_captured_at, "latest_captured_at");
  if (!Number.isInteger(context.interval_minutes) || (context.interval_minutes as number) <= 0) {
    throw new RangeError("interval_minutes must be a positive integer");
  }
  const retentionPolicyValue = requireRecord(context.retention_policy, "retention_policy");
  const retentionPolicy = {
    graceDays: requirePositiveInteger(retentionPolicyValue.grace_days, "retention_policy.grace_days"),
    growthDays: requirePositiveInteger(
      retentionPolicyValue.growth_days,
      "retention_policy.growth_days",
    ),
    pushDays: requirePositiveInteger(retentionPolicyValue.push_days, "retention_policy.push_days"),
    repositoryLimit: requirePositiveInteger(
      retentionPolicyValue.repository_limit,
      "retention_policy.repository_limit",
    ),
  };
  if (!Array.isArray(context.repositories)) {
    throw new TypeError("repositories must be an array");
  }
  const seen = new Set<string>();
  const repositories = context.repositories.map((repositoryValue, repositoryIndex) => {
    const repository = requireRecord(repositoryValue, `repositories[${repositoryIndex}]`);
    const fullName = requireFullName(repository.full_name, `repositories[${repositoryIndex}].full_name`);
    const key = fullName.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Collection context contains duplicate repository ${fullName}`);
    }
    seen.add(key);
    if (!Array.isArray(repository.observations)) {
      throw new TypeError(`repositories[${repositoryIndex}].observations must be an array`);
    }
    const observations = repository.observations.map((observationValue, observationIndex) => {
      const observation = requireRecord(
        observationValue,
        `repositories[${repositoryIndex}].observations[${observationIndex}]`,
      );
      return {
        capturedAt: requireTimestamp(
          observation.captured_at,
          `repositories[${repositoryIndex}].observations[${observationIndex}].captured_at`,
        ),
        stars: requireNonNegativeInteger(
          observation.stars,
          `repositories[${repositoryIndex}].observations[${observationIndex}].stars`,
        ),
      };
    });
    const firstObservedStars = requireNonNegativeInteger(
      repository.first_observed_stars,
      `repositories[${repositoryIndex}].first_observed_stars`,
    );
    const firstObservationWasTrending = requireBoolean(
      repository.first_observation_was_trending,
      `repositories[${repositoryIndex}].first_observation_was_trending`,
    );
    const officialTrendingEpisodeCount = requireNonNegativeInteger(
      repository.official_trending_episode_count,
      `repositories[${repositoryIndex}].official_trending_episode_count`,
    );
    const growthComparisonCapturedAt = repository.growth_comparison_captured_at === null
      ? null
      : requireTimestamp(
        repository.growth_comparison_captured_at,
        `repositories[${repositoryIndex}].growth_comparison_captured_at`,
      );
    const growthComparisonStars = repository.growth_comparison_stars === null
      ? null
      : requireNonNegativeInteger(
        repository.growth_comparison_stars,
        `repositories[${repositoryIndex}].growth_comparison_stars`,
      );
    if (firstObservationWasTrending && officialTrendingEpisodeCount === 0) {
      throw new RangeError(`repositories[${repositoryIndex}] has inconsistent Trending evidence`);
    }
    if ((growthComparisonCapturedAt === null) !== (growthComparisonStars === null)) {
      throw new TypeError(`repositories[${repositoryIndex}] has incomplete growth comparison`);
    }
    if (repository.repository_id !== undefined && (typeof repository.repository_id !== 'string' || !repository.repository_id.trim())) throw new TypeError('Repository identity must be a nonempty string');
    if (repository.identity_status !== undefined && repository.identity_status !== 'verified' && repository.identity_status !== 'legacy_unverified') throw new TypeError('Invalid repository identity status');
    return {
      fullName,
      ...(repository.repository_id === undefined ? {} : { repositoryId: repository.repository_id as string }),
      ...(repository.identity_status === undefined ? {} : { identityStatus: repository.identity_status as 'verified' | 'legacy_unverified' }),
      firstSeenAt: requireTimestamp(
        repository.first_seen_at,
        `repositories[${repositoryIndex}].first_seen_at`,
      ),
      firstObservedStars,
      firstObservationWasTrending,
      officialTrendingEpisodeCount,
      latestCapturedAt: requireTimestamp(
        repository.latest_captured_at,
        `repositories[${repositoryIndex}].latest_captured_at`,
      ),
      latestPushedAt: repository.latest_pushed_at === null
        ? null
        : requireTimestamp(
          repository.latest_pushed_at,
          `repositories[${repositoryIndex}].latest_pushed_at`,
        ),
      latestRank: requirePositiveInteger(
        repository.latest_rank,
        `repositories[${repositoryIndex}].latest_rank`,
      ),
      latestStars: requireNonNegativeInteger(
        repository.latest_stars,
        `repositories[${repositoryIndex}].latest_stars`,
      ),
      growthComparisonStars,
      growthComparisonCapturedAt,
      observations,
    };
  });
  return {
    latestCapturedAt,
    intervalMinutes: context.interval_minutes as number,
    retentionPolicy,
    repositories,
  };
}

export class RemoteHistoryApi {
  readonly baseUrl: string;
  readonly collectorToken: string;
  readonly fetchImplementation: typeof fetch;

  constructor({
    baseUrl,
    collectorToken,
    fetchImplementation = fetch,
  }: {
    baseUrl: string;
    collectorToken: string;
    fetchImplementation?: typeof fetch;
  }) {
    const parsedUrl = URL.parse(baseUrl);
    if (parsedUrl === null || !["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new TypeError("TREND_RADAR_API_URL must be an HTTP URL");
    }
    if (collectorToken.trim() === "") {
      throw new TypeError("TREND_RADAR_COLLECTOR_TOKEN is required");
    }
    this.baseUrl = parsedUrl.href.replace(/\/$/, "");
    this.collectorToken = collectorToken;
    this.fetchImplementation = fetchImplementation;
  }

  private async rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImplementation(`${this.baseUrl}/rpc/${name}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.collectorToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(`Remote history ${name} failed with status ${response.status}: ${responseBody}`);
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  }

  async startCollection(runId: string, startedAt: string): Promise<void> {
    await this.rpc("start_collection", { p_run_id: runId, p_started_at: startedAt });
  }

  async readCollectionRun(runId: string): Promise<CollectionRun | null> {
    requireUuid(runId, 'Collection run id');
    const value = await this.rpc('collection_run', { p_run_id: runId });
    if (value === null) return null;
    const run = requireRecord(value, 'Collection run');
    const id = requireUuid(run.id, 'Collection run.id');
    if (id !== runId) throw new Error('Collection run identity mismatch');
    if (run.status !== 'running' && run.status !== 'completed' && run.status !== 'failed') throw new TypeError('Invalid collection run status');
    const startedAt = requireTimestamp(run.started_at, 'Collection run.started_at');
    const finishedAt = run.finished_at === null ? null : requireTimestamp(run.finished_at, 'Collection run.finished_at');
    if ((run.status === 'running') !== (finishedAt === null)) throw new TypeError('Collection run status and finished_at disagree');
    if (run.status === 'failed' ? typeof run.error_message !== 'string' || !run.error_message.trim() : run.error_message !== null) throw new TypeError('Collection run status and error_message disagree');
    return { id, status: run.status, startedAt, finishedAt, errorMessage: run.error_message as string | null };
  }

  async readRepositoryIdentityContext(repositories: readonly RepositoryIdentityRequest[]): Promise<CollectionContext> {
    if (repositories.length < 1 || repositories.length > 10_000) throw new RangeError('Identity context requires 1-10000 repositories');
    const ids = new Set<string>();
    for (const repository of repositories) {
      if (typeof repository.repository_id !== 'string' || !repository.repository_id.trim() || ids.has(repository.repository_id)) throw new TypeError('Repository identity must be a unique nonempty string');
      ids.add(repository.repository_id);
      requireFullName(repository.full_name, 'Repository identity full_name');
      if (!Array.isArray(repository.requested_names) || repository.requested_names.length > 100) throw new RangeError('Repository identity requested_names requires at most 100 names');
      repository.requested_names.forEach(name => requireFullName(name, 'Repository identity requested name'));
    }
    return parseCollectionContext(await this.rpc('repository_identity_context', { p_repositories: repositories }));
  }

  async readCompletedEventHours(before: string, hours: number): Promise<string[]> {
    requireTimestamp(before, 'Event collection before');
    if (Date.parse(before) % 3_600_000 !== 0 || !Number.isInteger(hours) || hours < 1 || hours > 168) throw new RangeError('Event collection range requires an exact hour and 1-168 hours');
    const value = await this.rpc('completed_event_hours', { p_before: before, p_hours: hours });
    if (!Array.isArray(value)) throw new TypeError('Completed event hours must be an array');
    const seen = new Set<number>();
    return value.map(hour => {
      const timestamp = Date.parse(requireTimestamp(hour, 'Completed event hour'));
      if (timestamp % 3_600_000 !== 0 || timestamp > Date.parse(before) || timestamp <= Date.parse(before) - hours * 3_600_000 || seen.has(timestamp)) throw new Error('Completed event hour outside requested range or duplicated');
      seen.add(timestamp);
      return new Date(timestamp).toISOString();
    });
  }

  async completeEventHour(bucketAt: string, repositories: readonly GhArchiveRepositoryBucket[], metadata: EventHourMetadata): Promise<void> {
    requireTimestamp(bucketAt, 'Event hour');
    if (Date.parse(bucketAt) % 3_600_000 !== 0 || repositories.length > 10_000) throw new RangeError('Event hour requires an exact hour and at most 10000 repositories');
    requireNonNegativeInteger(metadata.sourceRepositoryCount, 'Event source repository count');
    requirePositiveInteger(metadata.lineCount, 'Event line count');
    requireNonNegativeInteger(metadata.rejectedLineCount, 'Event rejected line count');
    if (metadata.sourceRepositoryCount < repositories.length || metadata.rejectedLineCount > metadata.lineCount) throw new RangeError('Event hour counts are inconsistent');
    await this.rpc('complete_event_hour', { p_bucket_at: bucketAt, p_repositories: repositories, p_source_repository_count: metadata.sourceRepositoryCount, p_line_count: metadata.lineCount, p_rejected_line_count: metadata.rejectedLineCount });
  }

  async readCollectionSchedule(): Promise<CollectionSchedule> {
    return parseCollectionSchedule(await this.rpc("collection_schedule", {}));
  }

  async readCollectionSummary(): Promise<CollectionContext> {
    return parseCollectionContext(await this.rpc("collection_summary", {}));
  }

  async readRepositoryObservations(fullNames: readonly string[]): Promise<Array<{ fullName: string; observations: StarObservation[] }>> {
    if (fullNames.length < 1 || fullNames.length > 10_000) throw new RangeError("Repository observations require 1-10000 names");
    fullNames.forEach(name => requireFullName(name, "Repository observation name"));
    const response = requireRecord(await this.rpc("repository_observations", { p_full_names: fullNames }), "Repository observations");
    if (!Array.isArray(response.repositories)) throw new TypeError("Repository observations must be an array");
    const requested = new Set(fullNames.map(name => name.toLowerCase()));
    const seen = new Set<string>();
    return response.repositories.map(value => {
      const repository = requireRecord(value, "Repository observations entry");
      const fullName = requireFullName(repository.full_name, "Repository observation name");
      const key = fullName.toLowerCase();
      if (!requested.has(key) || seen.has(key)) throw new Error("Unexpected or duplicate repository observations");
      seen.add(key);
      if (!Array.isArray(repository.observations) || repository.observations.length < 1 || repository.observations.length > 20) throw new TypeError("Observations must contain 1-20 points");
      return { fullName, observations: repository.observations.map(value => {
        const observation = requireRecord(value, "Observation");
        return { capturedAt: requireTimestamp(observation.captured_at, "Observation timestamp"), stars: requireNonNegativeInteger(observation.stars, "Observation stars") };
      }) };
    });
  }

  async readCollectionContext(): Promise<CollectionContext> {
    return parseCollectionContext(await this.rpc("collection_context", {}));
  }

  async readSnapshotTimeline(): Promise<SnapshotTimelineEntry[]> {
    return parseSnapshotTimeline(await this.rpc("snapshot_timeline", {}));
  }

  async readEventSignals(): Promise<RepositoryEventSignals[]> {
    return parseEventSignalContext(await this.rpc("event_signal_context", {}));
  }

  async ingestEventBucket(
    bucketAt: string,
    repositories: readonly GhArchiveRepositoryBucket[],
  ): Promise<void> {
    requireTimestamp(bucketAt, "bucketAt");
    if (repositories.length === 0) {
      throw new RangeError("Event bucket must contain repositories");
    }
    await this.rpc("ingest_event_bucket", {
      p_bucket_at: bucketAt,
      p_repositories: repositories,
    });
  }

  async completeCollection({
    runId,
    capturedAt,
    source,
    repositories,
  }: {
    runId: string;
    capturedAt: string;
    source: string;
    repositories: readonly (RankedRepository | TrendRankedRepository)[];
  }): Promise<void> {
    if (repositories.length === 0) {
      throw new RangeError("Remote collection must contain repositories");
    }
    await this.rpc("complete_collection", {
      p_run_id: runId,
      p_captured_at: capturedAt,
      p_source: source,
      p_repositories: repositories,
    });
  }

  async failCollection(runId: string, finishedAt: string, errorMessage: string): Promise<void> {
    if (errorMessage.trim() === "") {
      throw new TypeError("Remote collection failure message is required");
    }
    await this.rpc("fail_collection", {
      p_run_id: runId,
      p_finished_at: finishedAt,
      p_error_message: errorMessage,
    });
  }
}
