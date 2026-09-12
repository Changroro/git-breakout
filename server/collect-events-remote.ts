import { parseEventCollectorArguments } from "./event-collector.ts";
import { collectEventHour } from './event-catchup.ts';
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
const completed = await historyApi.readCompletedEventHours(bucketAt, 1);
if (!completed.some(hour => Date.parse(hour) === Date.parse(bucketAt))) await collectEventHour(bucketAt, candidateLimit, historyApi);
process.stdout.write(`GH Archive ${bucketAt} complete\n`);
