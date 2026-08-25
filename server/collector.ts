import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { RepositoryCandidate, RepositoryGrowth } from "../src/lib/ranking.ts";
import { loadRepositoryCard } from "./card-cache.ts";
import { fetchGitHubTrendingRepositories, type GitHubRepositorySnapshot } from "./github.ts";
import { HistoryDatabase, type StarObservation } from "./history.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WINDOW_TOLERANCE_MS = 30 * 60_000;
const LEASE_DURATION_MS = 30 * 60_000;

export type CollectionResult = {
  runId: string;
  capturedAt: string;
  repositoryCount: number;
};

function deltaAtWindow(
  stars: number,
  capturedAt: number,
  observations: readonly StarObservation[],
  hours: number,
): number | null {
  const target = capturedAt - hours * HOUR_MS;
  const nearest = observations
    .map((observation) => ({
      observation,
      distance: Math.abs(Date.parse(observation.capturedAt) - target),
    }))
    .sort((left, right) => left.distance - right.distance)[0];
  if (nearest === undefined || nearest.distance > WINDOW_TOLERANCE_MS) {
    return null;
  }
  return Math.max(0, stars - nearest.observation.stars);
}

export function calculateGrowth(
  stars: number,
  capturedAt: string,
  observations: readonly StarObservation[],
): {
  growth: RepositoryGrowth;
  observedStarsPerDay: number | null;
  firstObservation: boolean;
} {
  const capturedTimestamp = Date.parse(capturedAt);
  if (!Number.isFinite(capturedTimestamp)) {
    throw new TypeError("capturedAt must be a valid ISO-8601 timestamp");
  }
  if (!Number.isInteger(stars) || stars < 0) {
    throw new RangeError("stars must be a non-negative integer");
  }
  if (observations.length === 0) {
    return {
      growth: {
        stars_delta_1h: null,
        stars_delta_6h: null,
        stars_delta_24h: null,
      },
      observedStarsPerDay: null,
      firstObservation: true,
    };
  }

  const latest = observations[0];
  const elapsed = capturedTimestamp - Date.parse(latest.capturedAt);
  if (!Number.isFinite(elapsed) || elapsed <= 0) {
    throw new RangeError("Previous observation must be earlier than capturedAt");
  }
  const observedStarsPerDay = Math.max(0, stars - latest.stars) / (elapsed / DAY_MS);
  return {
    growth: {
      stars_delta_1h: deltaAtWindow(stars, capturedTimestamp, observations, 1),
      stars_delta_6h: deltaAtWindow(stars, capturedTimestamp, observations, 6),
      stars_delta_24h: deltaAtWindow(stars, capturedTimestamp, observations, 24),
    },
    observedStarsPerDay,
    firstObservation: false,
  };
}

function toCandidate(
  repository: GitHubRepositorySnapshot,
  capturedAt: string,
  database: HistoryDatabase,
): RepositoryCandidate {
  const stars = repository.metrics.stars;
  if (stars === null) {
    throw new TypeError(`GitHub repository ${repository.fullName} is missing stars`);
  }
  const observation = calculateGrowth(
    stars,
    capturedAt,
    database.readStarObservations(repository.fullName, capturedAt, "github_official"),
  );
  return {
    full_name: repository.fullName,
    url: repository.url,
    open_graph_image_url: repository.openGraphImageUrl,
    description: repository.description,
    language: repository.language,
    topics: [...repository.topics],
    created_at: repository.createdAt,
    pushed_at: repository.pushedAt,
    metrics: { ...repository.metrics },
    official_ranks: { ...repository.officialRanks },
    growth: observation.growth,
    observedStarsPerDay: observation.observedStarsPerDay,
    firstObservation: observation.firstObservation,
  };
}

export async function collectOnce({
  databasePath,
  githubToken,
  fetchImplementation = fetch,
  now = () => new Date(),
}: {
  databasePath: string;
  githubToken: string;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
}): Promise<CollectionResult> {
  if (githubToken.trim() === "") {
    throw new TypeError("GITHUB_TOKEN is required");
  }
  const database = new HistoryDatabase(databasePath);
  const ownerId = randomUUID();
  const leaseStartedAt = now();
  const leaseExpiresAt = new Date(leaseStartedAt.getTime() + LEASE_DURATION_MS);
  if (!database.acquireCollectorLease(ownerId, leaseStartedAt.toISOString(), leaseExpiresAt.toISOString())) {
    database.close();
    throw new Error("Another collector run holds the active lease");
  }

  const runId = randomUUID();
  const startedAt = now().toISOString();
  let runStarted = false;
  try {
    database.startCollectorRun(runId, startedAt);
    runStarted = true;
    const repositories = await fetchGitHubTrendingRepositories(githubToken, fetchImplementation);
    const cardCacheDirectory = resolve(dirname(databasePath), "repository-cards");
    for (const repository of repositories) {
      await loadRepositoryCard(
        repository.fullName,
        repository.openGraphImageUrl,
        cardCacheDirectory,
        fetchImplementation,
      );
    }
    const capturedAt = now().toISOString();
    const candidates = repositories.map((repository) => toCandidate(repository, capturedAt, database));
    database.completeCollectorRun({
      id: runId,
      capturedAt,
      source: "github_official",
      repositories: candidates,
    });
    return { runId, capturedAt, repositoryCount: candidates.length };
  } catch (error) {
    if (runStarted) {
      database.failCollectorRun(
        runId,
        now().toISOString(),
        error instanceof Error ? error.message : "Unknown collector error",
      );
    }
    throw error;
  } finally {
    database.releaseCollectorLease(ownerId);
    database.close();
  }
}

export function defaultDatabasePath(): string {
  return resolve(process.cwd(), "data", "ranking-history.sqlite");
}
