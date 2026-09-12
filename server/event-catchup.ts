import { fetchGhArchiveBucket, selectEventCandidateBuckets, type GhArchiveAggregationResult, type GhArchiveRepositoryBucket } from './gh-archive.ts';

export type EventHourMetadata = { sourceRepositoryCount: number; lineCount: number; rejectedLineCount: number };
type EventHourWriter = { completeEventHour(hour: string, repositories: readonly GhArchiveRepositoryBucket[], metadata: EventHourMetadata): Promise<void> };
const HOUR_MS = 3_600_000;

export function selectMissingEventHours(now: string, completedHours: readonly string[], maxHours: number, lookbackHours = 72): string[] {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new TypeError('Event recovery time must be valid');
  if (!Number.isInteger(maxHours) || maxHours < 1 || maxHours > 6) throw new RangeError('Event recovery max hours must be between 1 and 6');
  if (!Number.isInteger(lookbackHours) || lookbackHours < 1 || lookbackHours > 168) throw new RangeError('Event recovery lookback must be between 1 and 168 hours');
  const completed = new Set(completedHours.map(hour => {
    const value = Date.parse(hour);
    if (!Number.isFinite(value) || value % HOUR_MS !== 0) throw new TypeError('Completed event hour must be an exact UTC hour');
    return value;
  }));
  const latestHour = Math.floor(timestamp / HOUR_MS) * HOUR_MS - 2 * HOUR_MS;
  const missing: string[] = [];
  for (let offset = 0; offset < lookbackHours && missing.length < maxHours; offset++) {
    const hour = latestHour - offset * HOUR_MS;
    if (!completed.has(hour)) missing.push(new Date(hour).toISOString());
  }
  return missing;
}

export async function collectEventHour(hour: string, candidateLimit: number, writer: EventHourWriter, fetchArchive: (hour: string) => Promise<GhArchiveAggregationResult> = fetchGhArchiveBucket): Promise<void> {
  const archive = await fetchArchive(hour);
  await writer.completeEventHour(hour, selectEventCandidateBuckets(archive.buckets, candidateLimit), {
    sourceRepositoryCount: archive.buckets.length,
    lineCount: archive.lineCount,
    rejectedLineCount: archive.rejectedLines.length,
  });
  if (archive.rejectedLines.length > 0) process.stderr.write(`GH Archive ${hour}: rejected ${archive.rejectedLines.length} of ${archive.lineCount} lines; event coverage is incomplete\n`);
}

export async function runEventCatchup(hours: readonly string[], collect: (hour: string) => Promise<void>): Promise<void> {
  const failures: Error[] = [];
  for (const hour of hours) {
    try {
      await collect(hour);
      process.stdout.write(`Completed GH Archive ${hour}\n`);
    } catch (error) {
      failures.push(new Error(`GH Archive ${hour}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} event hour failed: ${failures.map(error => error.message).join('; ')}`);
}
