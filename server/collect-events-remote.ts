import { parseEventCollectorArguments } from "./event-collector.ts";
import { fetchGhArchiveBucket, selectEventCandidateBuckets } from "./gh-archive.ts";
import { RemoteHistoryApi } from "./remote-history.ts";

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

const { bucketAt, candidateLimit } = parseEventCollectorArguments(process.argv.slice(2));
const historyApi = new RemoteHistoryApi({
  baseUrl: requireEnvironment("TREND_RADAR_API_URL"),
  collectorToken: requireEnvironment("TREND_RADAR_COLLECTOR_TOKEN"),
});
const archive = await fetchGhArchiveBucket(bucketAt);
const selectedBuckets = selectEventCandidateBuckets(archive.buckets, candidateLimit);
await historyApi.ingestEventBucket(bucketAt, selectedBuckets);
if (archive.rejectedLines.length > 0) {
  process.stderr.write(
    `Rejected ${archive.rejectedLines.length} of ${archive.lineCount} GH Archive lines: ${archive.rejectedLines.map((line) => `${line.lineNumber} ${line.reason}`).join(", ")}\n`,
  );
}
process.stdout.write(
  `Stored ${selectedBuckets.length} of ${archive.buckets.length} active repositories from GH Archive ${bucketAt}\n`,
);
