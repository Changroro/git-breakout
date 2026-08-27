import { randomUUID } from "node:crypto";
import { rankRepositories } from "../src/lib/ranking.ts";
import { createRepositoryCandidate } from "./collector.ts";
import { BOOTSTRAP_REPOSITORY_NAMES } from "./bootstrap-repositories.ts";
import { fetchGitHubRepositories } from "./github.ts";
import { RemoteHistoryApi } from "./remote-history.ts";
import { selectRetainedRepositoryNames } from "./retention.ts";

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

const githubToken = requireEnvironment("GITHUB_TOKEN");
const historyApi = new RemoteHistoryApi({
  baseUrl: requireEnvironment("TREND_RADAR_API_URL"),
  collectorToken: requireEnvironment("TREND_RADAR_COLLECTOR_TOKEN"),
});
const runId = randomUUID();
const startedAt = new Date().toISOString();
let started = false;

try {
  await historyApi.startCollection(runId, startedAt);
  started = true;
  const context = await historyApi.readCollectionContext();
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
  const repositories = await fetchGitHubRepositories({
    token: githubToken,
    capturedAt: startedAt,
    previouslyObservedNames: retainedRepositoryNames,
  });
  const capturedAt = new Date().toISOString();
  const candidates = repositories.map((repository) => createRepositoryCandidate(
    repository,
    capturedAt,
    observationsByName.get(repository.fullName.toLowerCase()) ?? [],
    context.intervalMinutes,
  ));
  const rankedRepositories = rankRepositories(candidates, capturedAt);
  await historyApi.completeCollection({
    runId,
    capturedAt,
    source: "github_combined",
    repositories: rankedRepositories,
  });
  process.stdout.write(
    `Collected ${rankedRepositories.length} repositories after retaining ${retainedRepositoryNames.length} of ${context.repositories.length} observed repositories in ${runId} at ${capturedAt}\n`,
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
