import { RemoteHistoryApi } from "./remote-history.ts";

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

const historyApi = new RemoteHistoryApi({
  baseUrl: requireEnvironment("TREND_RADAR_API_URL"),
  collectorToken: requireEnvironment("TREND_RADAR_COLLECTOR_TOKEN"),
});
const schedule = await historyApi.readCollectionSchedule();
process.stdout.write(`${JSON.stringify({ next_due_at: schedule.nextDueAt })}\n`);
