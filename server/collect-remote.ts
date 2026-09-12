import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { rankRepositories } from "../src/lib/ranking.ts";
import { rankTrendIntelligence } from "../src/lib/trend-intelligence.ts";
import { createRepositoryCandidate } from "./collector.ts";
import { BOOTSTRAP_REPOSITORY_NAMES } from "./bootstrap-repositories.ts";
import { fetchGitHubRepositories } from "./github.ts";
import { millisecondsUntilCollectionDue, RemoteHistoryApi } from "./remote-history.ts";
import { repositoryIdentityProofs } from "./repository-identity.ts";
import { selectRetainedRepositoryNames } from "./retention.ts";
import { collectStarHistories, readCoreRateLimit, starHistoryFetchBudget, StarHistoryStore } from "./star-history.ts";

type RemoteCollectionDependencies = {
  historyApi: Pick<RemoteHistoryApi, "startCollection" | "readCollectionSummary" | "readEventSignals" |
    "readRepositoryIdentityContext" | "completeCollection" | "readCollectionRun" | "failCollection">;
  githubToken: string;
  starHistoryStore: StarHistoryStore;
  reserve?: number | null;
  now?: () => Date;
  runId?: string;
  fetchRepositories?: typeof fetchGitHubRepositories;
  readRateLimit?: typeof readCoreRateLimit;
  collectHistories?: typeof collectStarHistories;
};

export async function collectRemoteOnce({
  historyApi, githubToken, starHistoryStore, reserve = null, now = () => new Date(), runId = randomUUID(),
  fetchRepositories = fetchGitHubRepositories, readRateLimit = readCoreRateLimit, collectHistories = collectStarHistories,
}: RemoteCollectionDependencies) {
  const startedAt = now().toISOString();
  let started = false;
  let completing = false;
  let result: { runId: string; capturedAt: string; repositoryCount: number; message: string } | undefined;
  try {
    await historyApi.startCollection(runId, startedAt);
    started = true;
    const [summary, eventSignals] = await Promise.all([historyApi.readCollectionSummary(), historyApi.readEventSignals()]);
    const retainedRepositoryNames = summary.latestCapturedAt === null
      ? [...BOOTSTRAP_REPOSITORY_NAMES]
      : selectRetainedRepositoryNames(summary.repositories, summary.latestCapturedAt, summary.retentionPolicy);
    const eventRepositoryNames = eventSignals.map(signals => signals.full_name);
    const repositories = await fetchRepositories({ token: githubToken, capturedAt: startedAt,
      retainedRepositoryNames, ghArchiveRepositoryNames: eventRepositoryNames });
    const identities = repositoryIdentityProofs(repositories);
    const [context, rateLimit] = await Promise.all([
      historyApi.readRepositoryIdentityContext(identities), readRateLimit(githubToken),
    ]);
    const previousByName = new Map(context.repositories.map(repository => [repository.fullName.toLowerCase(), repository]));
    const requestedIds = new Map(identities.map(identity => [identity.full_name.toLowerCase(), identity.repository_id]));
    for (const previous of context.repositories) {
      if (previous.repositoryId !== requestedIds.get(previous.fullName.toLowerCase())) {
        throw new Error("Repository identity context does not match the requested GitHub ID");
      }
      if (previous.observations.length === 0 || previous.identityStatus === undefined) {
        throw new Error("Repository identity context is missing observations or provenance");
      }
    }
    const fetchBudget = reserve === null ? starHistoryFetchBudget(rateLimit) : starHistoryFetchBudget(rateLimit, reserve);
    const starHistory = await collectHistories(repositories.map(repository => repository.fullName), starHistoryStore,
      { capturedAt: now().toISOString(), fetchBudget });
    const capturedAt = now().toISOString();
    if (starHistory.histories.some(history => Date.parse(history.captured_at) > Date.parse(capturedAt))) {
      throw new Error("Star history fetch time is later than the collection capture time");
    }
    const candidates = repositories.map(repository => {
      const previous = previousByName.get(repository.fullName.toLowerCase());
      return { ...createRepositoryCandidate(repository, capturedAt, previous?.observations ?? [], summary.intervalMinutes),
        identity_status: previous?.identityStatus ?? "verified" as const };
    });
    const rankedRepositories = rankRepositories(candidates, capturedAt);
    const intelligentRepositories = rankTrendIntelligence(rankedRepositories, eventSignals, capturedAt, starHistory.histories,
      rankedRepositories.map(repository => {
        const previous = previousByName.get(repository.full_name.toLowerCase());
        const currentlyTrending = Object.values(repository.official_ranks).some(rank => rank !== null);
        return { full_name: repository.full_name,
          first_observed_at: previous?.firstSeenAt ?? capturedAt,
          first_observed_stars: previous?.firstObservedStars ?? repository.metrics.stars!,
          first_observation_was_trending: previous?.firstObservationWasTrending ?? currentlyTrending,
          official_trending_episode_count: previous?.officialTrendingEpisodeCount ?? (currentlyTrending ? 1 : 0) };
      }));
    const aliasesById = new Map(identities.map(identity => [identity.repository_id, identity.requested_names]));
    const payload = intelligentRepositories.map(repository => ({ ...repository,
      repository_aliases: aliasesById.get(repository.repository_id!)! }));
    result = { runId, capturedAt, repositoryCount: payload.length,
      message: `Collected ${payload.length} repositories from ${eventRepositoryNames.length} event candidates after retaining ${retainedRepositoryNames.length} of ${summary.repositories.length} observed repositories in ${runId} at ${capturedAt}; star history refreshed ${starHistory.fetched}, reused ${starHistory.reused}, missing ${starHistory.skipped} within a budget of ${fetchBudget} from ${rateLimit.remaining} remaining core calls` };
    completing = true;
    await historyApi.completeCollection({ runId, capturedAt, source: "github_events_v2_shadow", repositories: payload });
    return result;
  } catch (error) {
    if (!started) throw error;
    const message = error instanceof Error ? error.message : "Unknown remote collector error";
    if (completing) {
      let status;
      try { status = await historyApi.readCollectionRun(runId); }
      catch (statusError) { throw new AggregateError([error, statusError], `Collection outcome is unknown for ${runId}; failure status was not written`); }
      if (status?.status === "completed") return result!;
      if (status === null) throw new AggregateError([error], `Collection outcome is unknown for ${runId}; failure status was not written`);
    }
    try {
      await historyApi.failCollection(runId, now().toISOString(), message);
      if (completing && (await historyApi.readCollectionRun(runId))?.status === "completed") return result!;
    } catch (failureError) {
      throw new AggregateError([error, failureError], `Remote collection and failure recording both failed for ${runId}`);
    }
    throw error;
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new TypeError(`${name} is required`);
  return value;
}

async function main() {
  const githubToken = requireEnvironment("GITHUB_TOKEN");
  const reserveValue = process.env.TREND_RADAR_STAR_HISTORY_RESERVE;
  if (reserveValue !== undefined && !/^\d+$/.test(reserveValue.trim())) {
    throw new TypeError("TREND_RADAR_STAR_HISTORY_RESERVE must be a non-negative integer");
  }
  const reserve = reserveValue === undefined ? null : Number(reserveValue.trim());
  if (reserve !== null && !Number.isSafeInteger(reserve)) throw new RangeError("Star history reserve must be a safe integer");
  const starHistoryStore = new StarHistoryStore({
    cacheDirectory: resolve(process.env.TREND_RADAR_STAR_HISTORY_CACHE_DIR ?? resolve(process.cwd(), "data", "star-history")),
    token: githubToken, ttlMs: 20 * 3_600_000, ttlJitterMs: 6 * 3_600_000,
  });
  const historyApi = new RemoteHistoryApi({ baseUrl: requireEnvironment("TREND_RADAR_API_URL"),
    collectorToken: requireEnvironment("TREND_RADAR_COLLECTOR_TOKEN") });
  const schedule = await historyApi.readCollectionSchedule();
  const waitMilliseconds = millisecondsUntilCollectionDue(schedule, new Date());
  if (waitMilliseconds > 0) {
    process.stdout.write(`Collection is due at ${schedule.nextDueAt}; waiting ${waitMilliseconds}ms\n`);
    await wait(waitMilliseconds);
  }
  const result = await collectRemoteOnce({ historyApi, githubToken, starHistoryStore, reserve });
  process.stdout.write(result.message + "\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
