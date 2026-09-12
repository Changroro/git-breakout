import { collectEventHour, runEventCatchup, selectMissingEventHours } from './event-catchup.ts';
import { RemoteHistoryApi } from './remote-history.ts';

const values = new Map<string, number>();
for (const arg of process.argv.slice(2)) {
  const match = /^--(max-hours|limit)=(\d+)$/.exec(arg);
  if (match === null || values.has(match[1])) throw new TypeError(`Invalid event recovery argument ${arg}`);
  values.set(match[1], Number(match[2]));
}
const maxHours = values.get('max-hours');
const limit = values.get('limit');
if (maxHours === undefined || limit === undefined) throw new TypeError('Event recovery requires --max-hours and --limit');
if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError('Event recovery limit must be between 1 and 10000');
const baseUrl = process.env.TREND_RADAR_API_URL;
const collectorToken = process.env.TREND_RADAR_COLLECTOR_TOKEN;
if (!baseUrl?.trim() || !collectorToken?.trim()) throw new TypeError('TREND_RADAR_API_URL and TREND_RADAR_COLLECTOR_TOKEN are required');
const api = new RemoteHistoryApi({ baseUrl, collectorToken });
const now = new Date().toISOString();
const latestHour = selectMissingEventHours(now, [], maxHours)[0];
const completed = await api.readCompletedEventHours(latestHour, 72);
const missing = selectMissingEventHours(now, completed, maxHours);
await runEventCatchup(missing, hour => collectEventHour(hour, limit, api));
process.stdout.write(`Event recovery processed ${missing.length} hours; ${completed.length} completed hours skipped\n`);
