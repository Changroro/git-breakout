import {
  parseRankingSnapshot,
  parseTimelineResponse,
  type RankingSnapshot,
  type TimelineResponse,
} from "../src/lib/history.ts";
import { parseSnapshotTimeline } from "./remote-history.ts";
import {
  parseStarSeriesResponse,
  type StarSeriesResponse,
} from "../src/lib/star-series.ts";

const REQUEST_TIMEOUT_MS = 30_000;

function validateBaseUrl(value: string): string {
  const url = URL.parse(value);
  if (url === null || !["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("TREND_RADAR_INTERNAL_API_URL must be an HTTP URL");
  }
  return url.href.replace(/\/$/, "");
}

async function readJsonResponse(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${operation} failed with status ${response.status}: ${await response.text()}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new TypeError(`${operation} returned ${contentType || "no content type"}`);
  }
  return response.json();
}

export class PublicHistoryApi {
  readonly baseUrl: string;
  readonly fetchImplementation: typeof fetch;

  constructor({
    baseUrl,
    fetchImplementation = fetch,
  }: {
    baseUrl: string;
    fetchImplementation?: typeof fetch;
  }) {
    this.baseUrl = validateBaseUrl(baseUrl);
    this.fetchImplementation = fetchImplementation;
  }

  private async rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImplementation(`${this.baseUrl}/rpc/${name}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return readJsonResponse(response, `Public history ${name}`);
  }

  async readTimeline(): Promise<TimelineResponse> {
    const timeline = parseSnapshotTimeline(await this.rpc("snapshot_timeline", {}));
    return parseTimelineResponse({
      schema_version: "1.0",
      snapshots: timeline.map((snapshot) => ({
        id: snapshot.id,
        captured_at: snapshot.capturedAt,
        source: snapshot.source,
        repository_count: snapshot.repositoryCount,
      })),
    });
  }

  async readSnapshot(snapshotId: string): Promise<RankingSnapshot> {
    const timeline = await this.readTimeline();
    const metadata = timeline.snapshots.find((snapshot) => snapshot.id === snapshotId);
    if (metadata === undefined) {
      throw new RangeError(`Snapshot ${snapshotId} does not exist`);
    }
    const repositories = await this.rpc("snapshot_repositories", {
      p_snapshot_id: snapshotId,
    });
    if (!Array.isArray(repositories)) {
      throw new TypeError(`Snapshot ${snapshotId} repositories must be an array`);
    }
    if (repositories.length !== metadata.repository_count) {
      throw new RangeError(
        `Snapshot ${snapshotId} expected ${metadata.repository_count} repositories, received ${repositories.length}`,
      );
    }
    return parseRankingSnapshot({
      id: metadata.id,
      captured_at: metadata.captured_at,
      source: metadata.source,
      repositories,
    });
  }

  async readStarSeries(
    snapshotId: string,
    repositoryNames: readonly string[],
  ): Promise<StarSeriesResponse> {
    if (
      repositoryNames.length < 1
      || repositoryNames.length > 10
      || repositoryNames.some((name) => !/^[^/\s]+\/[^/\s]+$/.test(name))
    ) {
      throw new TypeError("Star series requires 1-10 repositories in owner/name format");
    }
    const requestedNames = new Set(repositoryNames.map((name) => name.toLowerCase()));
    if (requestedNames.size !== repositoryNames.length) {
      throw new TypeError("Star series repository names must be unique");
    }
    const response = parseStarSeriesResponse(await this.rpc("repository_star_series", {
      p_snapshot_id: snapshotId,
      p_full_names: repositoryNames,
    }));
    const receivedNames = new Set(response.series.map((series) => series.full_name.toLowerCase()));
    if (
      response.series.length !== repositoryNames.length
      || [...requestedNames].some((name) => !receivedNames.has(name))
    ) {
      throw new Error("Star series response does not match the requested repositories");
    }
    return response;
  }
}
