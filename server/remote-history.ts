import type { RankedRepository } from "../src/lib/ranking.ts";
import type { StarObservation } from "./history.ts";

type CollectionContext = {
  latestCapturedAt: string | null;
  intervalMinutes: number;
  repositories: Array<{
    fullName: string;
    observations: StarObservation[];
  }>;
};

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
      if (!Number.isInteger(observation.stars) || (observation.stars as number) < 0) {
        throw new RangeError(
          `repositories[${repositoryIndex}].observations[${observationIndex}].stars must be a non-negative integer`,
        );
      }
      return {
        capturedAt: requireTimestamp(
          observation.captured_at,
          `repositories[${repositoryIndex}].observations[${observationIndex}].captured_at`,
        ),
        stars: observation.stars as number,
      };
    });
    return { fullName, observations };
  });
  return {
    latestCapturedAt,
    intervalMinutes: context.interval_minutes as number,
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

  async readCollectionContext(): Promise<CollectionContext> {
    return parseCollectionContext(await this.rpc("collection_context", {}));
  }

  async readSnapshotTimeline(): Promise<SnapshotTimelineEntry[]> {
    return parseSnapshotTimeline(await this.rpc("snapshot_timeline", {}));
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
    repositories: readonly RankedRepository[];
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
