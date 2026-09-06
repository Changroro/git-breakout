import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { rankRepositories } from "../src/lib/ranking.ts";
import { rankTrendIntelligence } from "../src/lib/trend-intelligence.ts";
import { createRepositoryCandidate } from "./collector.ts";
import { BOOTSTRAP_REPOSITORY_NAMES } from "./bootstrap-repositories.ts";
import { fetchGitHubRepositories } from "./github.ts";
import { millisecondsUntilCollectionDue, RemoteHistoryApi } from "./remote-history.ts";
import { selectRetainedRepositoryNames } from "./retention.ts";
import { collectStarHistories, StarHistoryStore } from "./star-history.ts";

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

const githubToken = requireEnvironment("GITHUB_TOKEN");
// Completed history days only change once a day, so the collector refreshes
// each repository roughly daily. The jitter spreads those refreshes across the
// two-hourly runs instead of re-reading the whole candidate pool at once.
const starHistoryStore = new StarHistoryStore({
  cacheDirectory: resolve(
    process.env.TREND_RADAR_STAR_HISTORY_CACHE_DIR ?? resolve(process.cwd(), "data", "star-history"),
  ),
  token: githubToken,
  ttlMs: 20 * 3_600_000,
  ttlJitterMs: 6 * 3_600_000,
});
const historyApi = new RemoteHistoryApi({
  baseUrl: requireEnvironment("TREND_RADAR_API_URL"),
  collectorToken: requireEnvironment("TREND_RADAR_COLLECTOR_TOKEN"),
});
const schedule = await historyApi.readCollectionSchedule();
const waitMilliseconds = millisecondsUntilCollectionDue(schedule, new Date());
if (waitMilliseconds > 0) {
  process.stdout.write(`Collection is due at ${schedule.nextDueAt}; waiting ${waitMilliseconds}ms\n`);
  await wait(waitMilliseconds);
}
const runId = randomUUID();
const startedAt = new Date().toISOString();
let started = false;

try {
  await historyApi.startCollection(runId, startedAt);
  started = true;
  const context = await historyApi.readCollectionContext();
  const eventSignals = await historyApi.readEventSignals();
  const observationsByName = new Map(
    context.repositories.map((repository) => [repository.fullName.toLowerCase(), repository.observations]),
  );
  const retainedRepositoryNames = context.latestCapturedAt === null
    ? [...BOOTSTRAP_REPOSITORY_NAMES]
    : selectRetainedRepositoryNames(
      context.repositories,
      context.latestCapturedAt,
      context.retentionPolicy,
    );
  const eventRepositoryNames = eventSignals.map((signals) => signals.full_name);
  const repositories = await fetchGitHubRepositories({
    token: githubToken,
    capturedAt: startedAt,
    retainedRepositoryNames,
    ghArchiveRepositoryNames: eventRepositoryNames,
  });
  const starHistories = await collectStarHistories(
    repositories.map((repository) => repository.fullName),
    starHistoryStore,
    { capturedAt: new Date().toISOString() },
  );
  const capturedAt = new Date().toISOString();
  const candidates = repositories.map((repository) => createRepositoryCandidate(
    repository,
    capturedAt,
    observationsByName.get(repository.fullName.toLowerCase()) ?? [],
    context.intervalMinutes,
  ));
  const rankedRepositories = rankRepositories(candidates, capturedAt);
  const intelligentRepositories = rankTrendIntelligence(
    rankedRepositories,
    eventSignals,
    capturedAt,
    starHistories,
  );
  await historyApi.completeCollection({
    runId,
    capturedAt,
    source: "github_events_v2_shadow",
    repositories: intelligentRepositories,
  });
  process.stdout.write(
    `Collected ${intelligentRepositories.length} repositories (${starHistories.length} with GitHub star history) from ${eventRepositoryNames.length} event candidates after retaining ${retainedRepositoryNames.length} of ${context.repositories.length} observed repositories in ${runId} at ${capturedAt}\n`,
  );
} catch (error) {
  if (started) {
    const message = error instanceof Error ? error.message : "Unknown remote collector error";
    try {
      await historyApi.failCollection(runId, new Date().toISOString(), message);
    } catch (failureError) {
      throw new AggregateError(
        [error, failureError],
        `Remote collection and failure recording both failed for ${runId}`,
      );
    }
  }
  throw error;
}
