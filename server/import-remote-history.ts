import { resolve } from "node:path";
import { HistoryDatabase } from "./history.ts";
import { RemoteHistoryApi } from "./remote-history.ts";

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

const databasePath = process.argv[2];
if (databasePath === undefined || databasePath.trim() === "") {
  throw new TypeError("SQLite database path is required");
}

const historyApi = new RemoteHistoryApi({
  baseUrl: requireEnvironment("TREND_RADAR_API_URL"),
  collectorToken: requireEnvironment("TREND_RADAR_COLLECTOR_TOKEN"),
});
const database = new HistoryDatabase(resolve(databasePath));

try {
  const history = database.readHistory();
  const remoteTimeline = await historyApi.readSnapshotTimeline();
  const remoteById = new Map(remoteTimeline.map((snapshot) => [snapshot.id, snapshot]));
  const remoteByCapturedAt = new Map(
    remoteTimeline.map((snapshot) => [Date.parse(snapshot.capturedAt), snapshot]),
  );
  for (const snapshot of history.snapshots) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshot.id)) {
      throw new TypeError(`Snapshot ${snapshot.id} must use UUID format`);
    }
    const existingById = remoteById.get(snapshot.id);
    const existingByCapturedAt = remoteByCapturedAt.get(Date.parse(snapshot.captured_at));
    const existing = existingById ?? existingByCapturedAt;
    if (existing !== undefined) {
      if (
        existing.id !== snapshot.id
        || Date.parse(existing.capturedAt) !== Date.parse(snapshot.captured_at)
        || existing.source !== snapshot.source
        || existing.repositoryCount !== snapshot.repositories.length
      ) {
        throw new Error(`Remote snapshot conflicts with local snapshot ${snapshot.id}`);
      }
      process.stdout.write(
        `Verified ${snapshot.repositories.length} existing repositories from ${snapshot.captured_at}\n`,
      );
      continue;
    }
    await historyApi.startCollection(snapshot.id, snapshot.captured_at);
    try {
      await historyApi.completeCollection({
        runId: snapshot.id,
        capturedAt: snapshot.captured_at,
        source: snapshot.source,
        repositories: snapshot.repositories,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown snapshot import error";
      await historyApi.failCollection(snapshot.id, new Date().toISOString(), message);
      throw error;
    }
    process.stdout.write(
      `Imported ${snapshot.repositories.length} repositories from ${snapshot.captured_at}\n`,
    );
  }
} finally {
  database.close();
}
