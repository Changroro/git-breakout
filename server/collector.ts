import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { RepositoryCandidate, RepositoryGrowth } from "../src/lib/ranking.ts";
import { BOOTSTRAP_REPOSITORY_NAMES } from "./bootstrap-repositories.ts";
import { fetchGitHubRepositories, type GitHubRepositorySnapshot } from "./github.ts";
import { HistoryDatabase, type StarObservation } from "./history.ts";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WINDOW_TOLERANCE_MS = 30 * 60_000;
const LEASE_DURATION_MS = 30 * 60_000;

export type CollectionResult = {
  runId: string;
  capturedAt: string;
  repositoryCount: number;
};

export function millisecondsUntilNextCollection(
  now: Date,
  latestCompletedStartedAt: string | null,
  intervalMinutes: number,
): number {
  const nowTimestamp = now.getTime();
  if (!Number.isFinite(nowTimestamp)) {
    throw new TypeError("now must be a valid date");
  }
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
    throw new RangeError("intervalMinutes must be a positive integer");
  }
  if (latestCompletedStartedAt === null) {
    return 0;
  }
  const latestTimestamp = Date.parse(latestCompletedStartedAt);
  if (!Number.isFinite(latestTimestamp) || latestTimestamp > nowTimestamp) {
    throw new RangeError("Latest completed collector start must be valid and not in the future");
  }
  return Math.max(0, latestTimestamp + intervalMinutes * MINUTE_MS - nowTimestamp);
}

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
  observationIntervalMinutes: number,
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
  if (!Number.isInteger(observationIntervalMinutes) || observationIntervalMinutes <= 0) {
    throw new RangeError("observationIntervalMinutes must be a positive integer");
  }
  const validatedObservations = observations.map((observation) => {
    const elapsed = capturedTimestamp - Date.parse(observation.capturedAt);
    if (
      !Number.isInteger(observation.stars) ||
      observation.stars < 0 ||
      !Number.isFinite(elapsed) ||
      elapsed <= 0
    ) {
      throw new RangeError("Previous observations must contain valid stars and precede capturedAt");
    }
    return { observation, elapsed };
  });
  const growth = {
    stars_delta_1h: deltaAtWindow(stars, capturedTimestamp, observations, 1),
    stars_delta_6h: deltaAtWindow(stars, capturedTimestamp, observations, 6),
    stars_delta_24h: deltaAtWindow(stars, capturedTimestamp, observations, 24),
  };
  if (observations.length === 0) {
    return {
      growth,
      observedStarsPerDay: null,
      firstObservation: true,
    };
  }

  const baseline = validatedObservations
    .filter(({ elapsed }) => elapsed >= observationIntervalMinutes * MINUTE_MS)
    .sort((left, right) => left.elapsed - right.elapsed)[0];
  if (baseline === undefined) {
    return {
      growth,
      observedStarsPerDay: null,
      firstObservation: true,
    };
  }
  const observedStarsPerDay = Math.max(0, stars - baseline.observation.stars) /
    (baseline.elapsed / DAY_MS);
  return {
    growth,
    observedStarsPerDay,
    firstObservation: false,
  };
}

export function createRepositoryCandidate(
  repository: GitHubRepositorySnapshot,
  capturedAt: string,
  observations: readonly StarObservation[],
  observationIntervalMinutes: number,
): RepositoryCandidate {
  const stars = repository.metrics.stars;
  if (stars === null) {
    throw new TypeError(`GitHub repository ${repository.fullName} is missing stars`);
  }
  const observation = calculateGrowth(
    stars,
    capturedAt,
    observations,
    observationIntervalMinutes,
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
    const repositories = await fetchGitHubRepositories({
      token: githubToken,
      capturedAt: startedAt,
      previouslyObservedNames: database.readLatestCollectionCapturedAt() === null
        ? [...BOOTSTRAP_REPOSITORY_NAMES]
        : database.readRetainedRepositoryNames(),
      fetchImplementation,
    });
    const capturedAt = now().toISOString();
    const observationIntervalMinutes = database.readCollectionIntervalMinutes();
    const candidates = repositories.map((repository) => createRepositoryCandidate(
      repository,
      capturedAt,
      database.readStarObservations(repository.fullName, capturedAt),
      observationIntervalMinutes,
    ));
    database.completeCollectorRun({
      id: runId,
      capturedAt,
      source: "github_combined",
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
