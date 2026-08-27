import {
  collectOnce,
  defaultDatabasePath,
  millisecondsUntilNextCollection,
} from "./collector.ts";
import { HistoryDatabase } from "./history.ts";

const configuredGithubToken = process.env.GITHUB_TOKEN;
if (configuredGithubToken === undefined || configuredGithubToken.trim() === "") {
  throw new TypeError("GITHUB_TOKEN is required");
}
const githubToken: string = configuredGithubToken;

const databasePath = defaultDatabasePath();
const settingsDatabase = new HistoryDatabase(databasePath);
const intervalMinutes = settingsDatabase.readCollectionIntervalMinutes();
const intervalMilliseconds = intervalMinutes * 60_000;
const initialDelayMilliseconds = millisecondsUntilNextCollection(
  new Date(),
  settingsDatabase.readLatestCollectionCapturedAt(),
  intervalMinutes,
);
settingsDatabase.close();
const failureRetryMilliseconds = 5 * 60_000;

let stopped = false;
let timeout: NodeJS.Timeout | null = null;

async function runAndSchedule(): Promise<void> {
  let nextDelay = intervalMilliseconds;
  try {
    const result = await collectOnce({ databasePath, githubToken });
    process.stdout.write(
      `Collected ${result.repositoryCount} repositories in ${result.runId} at ${result.capturedAt}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : "Unknown collector error"}\n`);
    nextDelay = failureRetryMilliseconds;
  }
  if (!stopped) {
    timeout = setTimeout(() => void runAndSchedule(), nextDelay);
  }
}

function stop(): void {
  stopped = true;
  if (timeout !== null) {
    clearTimeout(timeout);
  }
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
if (initialDelayMilliseconds === 0) {
  await runAndSchedule();
} else {
  timeout = setTimeout(() => void runAndSchedule(), initialDelayMilliseconds);
}
