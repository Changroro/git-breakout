import {
  parseRankingPageResponse,
  parseRankingSnapshot,
  parseRepositorySearchResponse,
  parseTimelineResponse,
  type RankingPageResponse,
  type RankingSnapshot,
  type RepositorySearchResponse,
  type TimelineResponse,
} from "../src/lib/history.ts";
import type { RankingView } from "../src/lib/repository-filters.ts";
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

  async readHealth(): Promise<{ status: "ok" }> {
    const response = await this.rpc("health", {});
    if (
      typeof response !== "object"
      || response === null
      || !("status" in response)
      || response.status !== "ok"
    ) {
      throw new TypeError("Public history health response must report ok");
    }
    return { status: "ok" };
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

  async readRankingPage({
    snapshotId,
    page,
    pageSize,
    language,
    topic,
    view,
  }: {
    snapshotId: string;
    page: number;
    pageSize: number;
    language: string | null;
    topic: string | null;
    view: RankingView;
  }): Promise<RankingPageResponse> {
    if (!Number.isInteger(page) || page < 1) {
      throw new RangeError("Ranking page must be a positive integer");
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new RangeError("Ranking page size must be between 1 and 100");
    }
    return parseRankingPageResponse(await this.rpc("snapshot_page", {
      p_snapshot_id: snapshotId,
      p_page: page,
      p_page_size: pageSize,
      p_language: language,
      p_topic: topic,
      p_view: view,
    }));
  }

  async searchRepositories(
    snapshotId: string,
    query: string,
    limit: number,
  ): Promise<RepositorySearchResponse> {
    if (query.trim() === "" || query.length > 200) {
      throw new TypeError("Repository search query must contain 1 to 200 characters");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new RangeError("Repository search limit must be between 1 and 20");
    }
    return parseRepositorySearchResponse(await this.rpc("search_snapshot_repositories", {
      p_snapshot_id: snapshotId,
      p_query: query,
      p_limit: limit,
    }));
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
