import { collectOnce, defaultDatabasePath } from "./collector.ts";

const githubToken = process.env.GITHUB_TOKEN;
if (githubToken === undefined || githubToken.trim() === "") {
  throw new TypeError("GITHUB_TOKEN is required");
}

const result = await collectOnce({
  databasePath: defaultDatabasePath(),
  githubToken,
});
process.stdout.write(
  `Collected ${result.repositoryCount} repositories in ${result.runId} at ${result.capturedAt}\n`,
);
