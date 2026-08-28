import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const RELEVANT_EVENT_FIELDS = {
  WatchEvent: "watches",
  ForkEvent: "forks",
  PullRequestEvent: "pull_requests",
  IssuesEvent: "issues",
  IssueCommentEvent: "issue_comments",
  PushEvent: "pushes",
  ReleaseEvent: "releases",
} as const;

type RelevantEventType = keyof typeof RELEVANT_EVENT_FIELDS;
type CountField = typeof RELEVANT_EVENT_FIELDS[RelevantEventType];

export type GhArchiveRepositoryBucket = {
  bucket_at: string;
  full_name: string;
  watches: number;
  forks: number;
  pull_requests: number;
  issues: number;
  issue_comments: number;
  pushes: number;
  releases: number;
  actor_ids: number[];
};

type MutableBucket = Omit<GhArchiveRepositoryBucket, "actor_ids"> & {
  actorIds: Set<number>;
};

function parseBucketTimestamp(value: string): Date {
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime())
    || date.getUTCMinutes() !== 0
    || date.getUTCSeconds() !== 0
    || date.getUTCMilliseconds() !== 0
  ) {
    throw new TypeError("GH Archive bucket must be an exact UTC hour");
  }
  return date;
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function addLine(
  buckets: Map<string, MutableBucket>,
  line: string,
  bucketAt: string,
  lineNumber: number,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new SyntaxError(`GH Archive line ${lineNumber} is invalid JSON: ${String(error)}`);
  }
  const event = recordValue(parsed, `GH Archive line ${lineNumber}`);
  if (typeof event.type !== "string" || !(event.type in RELEVANT_EVENT_FIELDS)) return;
  const eventType = event.type as RelevantEventType;
  const actor = recordValue(event.actor, `GH Archive line ${lineNumber} actor`);
  const repository = recordValue(event.repo, `GH Archive line ${lineNumber} repo`);
  if (!Number.isInteger(actor.id) || (actor.id as number) <= 0) {
    throw new TypeError(`GH Archive line ${lineNumber} actor.id must be a positive integer`);
  }
  if (typeof repository.name !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repository.name)) {
    throw new TypeError(`GH Archive line ${lineNumber} repo.name must use owner/name format`);
  }
  if (eventType === "WatchEvent") {
    const payload = recordValue(event.payload, `GH Archive line ${lineNumber} payload`);
    if (payload.action !== "started") {
      throw new TypeError(`GH Archive line ${lineNumber} WatchEvent action must be started`);
    }
  }

  const key = repository.name.toLocaleLowerCase("en-US");
  const bucket = buckets.get(key) ?? {
    bucket_at: bucketAt,
    full_name: repository.name,
    watches: 0,
    forks: 0,
    pull_requests: 0,
    issues: 0,
    issue_comments: 0,
    pushes: 0,
    releases: 0,
    actorIds: new Set<number>(),
  };
  const countField: CountField = RELEVANT_EVENT_FIELDS[eventType];
  bucket[countField] += 1;
  bucket.actorIds.add(actor.id as number);
  buckets.set(key, bucket);
}

function finalizeBuckets(buckets: Map<string, MutableBucket>): GhArchiveRepositoryBucket[] {
  return [...buckets.values()]
    .map(({ actorIds, ...bucket }) => ({
      ...bucket,
      actor_ids: [...actorIds].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.full_name.localeCompare(right.full_name));
}

export function aggregateGhArchiveLines(
  lines: readonly string[],
  bucketAt: string,
): GhArchiveRepositoryBucket[] {
  parseBucketTimestamp(bucketAt);
  const buckets = new Map<string, MutableBucket>();
  lines.forEach((line, index) => addLine(buckets, line, bucketAt, index + 1));
  return finalizeBuckets(buckets);
}

function eventDiversity(bucket: GhArchiveRepositoryBucket): number {
  return [
    bucket.watches,
    bucket.forks,
    bucket.pull_requests + bucket.issues + bucket.issue_comments,
    bucket.pushes + bucket.releases,
  ].filter((count) => count > 0).length;
}

function eventCount(bucket: GhArchiveRepositoryBucket): number {
  return bucket.watches
    + bucket.forks
    + bucket.pull_requests
    + bucket.issues
    + bucket.issue_comments
    + bucket.pushes
    + bucket.releases;
}

export function selectEventCandidateBuckets(
  buckets: readonly GhArchiveRepositoryBucket[],
  limit: number,
): GhArchiveRepositoryBucket[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError("GH Archive candidate limit must be a positive integer");
  }
  return [...buckets]
    .sort((left, right) =>
      right.actor_ids.length - left.actor_ids.length
      || eventDiversity(right) - eventDiversity(left)
      || eventCount(right) - eventCount(left)
      || left.full_name.localeCompare(right.full_name)
    )
    .slice(0, limit)
    .map((bucket) => ({ ...bucket, actor_ids: [...bucket.actor_ids] }));
}

export function formatGhArchiveUrl(bucketAt: string): string {
  const date = parseBucketTimestamp(bucketAt);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `https://data.gharchive.org/${year}-${month}-${day}-${date.getUTCHours()}.json.gz`;
}

export async function fetchGhArchiveBucket(
  bucketAt: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<GhArchiveRepositoryBucket[]> {
  parseBucketTimestamp(bucketAt);
  const url = formatGhArchiveUrl(bucketAt);
  const response = await fetchImplementation(url, {
    headers: { Accept: "application/gzip" },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok) {
    throw new Error(`GH Archive ${bucketAt} failed with status ${response.status}: ${await response.text()}`);
  }
  if (response.body === null) {
    throw new Error(`GH Archive ${bucketAt} returned an empty response body`);
  }

  const compressed = Readable.fromWeb(response.body);
  const lines = createInterface({ input: compressed.pipe(createGunzip()), crlfDelay: Infinity });
  const buckets = new Map<string, MutableBucket>();
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    addLine(buckets, line, bucketAt, lineNumber);
  }
  if (lineNumber === 0) {
    throw new Error(`GH Archive ${bucketAt} contained no events`);
  }
  return finalizeBuckets(buckets);
}
