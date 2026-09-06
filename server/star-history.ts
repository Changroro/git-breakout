import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  STAR_SERIES_WINDOW_DAYS,
  parseStarSeriesResponse,
  type RepositoryStarPoint,
  type RepositoryStarSeries,
  type StarSeriesResponse,
} from "../src/lib/star-series.ts";

const DAY_MS = 86_400_000;
const HISTORY_PAGE_WEEKS = 30;
const HISTORY_PAGE_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 6 * 3_600_000;
const GITHUB_API_VERSION = "2026-03-10";
const USER_AGENT = "ai-trend-radar/0.0.0";

export type StarHistoryDay = {
  /** ISO timestamp for the start of the GitHub day bucket. */
  start: string;
  /** ISO timestamp for the start of the following bucket. */
  end: string;
  stars_added: number;
};

export type GitHubStarHistory = {
  schema_version: "1.0";
  full_name: string;
  /** Moment the star count anchor was read from GitHub. */
  fetched_at: string;
  /** Repository stargazer count at fetched_at. */
  stars: number;
  /** True when the fetched pages reached the repository's creation week. */
  complete: boolean;
  /** Day buckets in ascending order. */
  days: StarHistoryDay[];
};

/**
 * GitHub creates the bucket for a new week shortly after it starts. Until it
 * appears the stars gained since the last bucket cannot be separated from
 * the current count, so no exact day-end value can be derived.
 */
export class StarHistoryLagError extends Error {
  constructor(fullName: string, fetchedAt: string) {
    super(`GitHub star history for ${fullName} does not cover ${fetchedAt} yet`);
    this.name = "StarHistoryLagError";
  }
}

type StarHistoryWeek = {
  week: number;
  total: number;
  days: number[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFullName(value: string): { owner: string; name: string } {
  const segments = value.split("/");
  if (
    value.trim() !== value
    || segments.length !== 2
    || segments.some((segment) => segment.length === 0 || /\s/.test(segment))
  ) {
    throw new TypeError(`Repository ${value} must use owner/name format`);
  }
  return { owner: segments[0], name: segments[1] };
}

function requireTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${field} must be a valid ISO-8601 timestamp`);
  }
  return timestamp;
}

function requireResponseOk(response: Response, source: string): void {
  if (response.ok) {
    return;
  }
  const resetHeader = response.headers.get("x-ratelimit-reset");
  const resetAt = resetHeader === null ? null : new Date(Number(resetHeader) * 1000);
  const resetMessage = resetAt !== null && Number.isFinite(resetAt.getTime())
    ? `; rate limit resets at ${resetAt.toISOString()}`
    : "";
  throw new Error(`${source} request failed with status ${response.status}${resetMessage}`);
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

export function parseStarHistoryPage(value: unknown, fullName: string): StarHistoryWeek[] {
  if (!Array.isArray(value) || value.length > HISTORY_PAGE_WEEKS) {
    throw new TypeError(`GitHub star history for ${fullName} must be an array of at most ${HISTORY_PAGE_WEEKS} weeks`);
  }
  let previousWeek = Number.POSITIVE_INFINITY;
  return value.map((entry, index) => {
    if (
      !isRecord(entry)
      || !Number.isInteger(entry.week)
      || (entry.week as number) < 0
      || !Number.isInteger(entry.total)
      || !Array.isArray(entry.days)
      || entry.days.length !== 7
      || entry.days.some((count) => !Number.isInteger(count))
    ) {
      throw new TypeError(`GitHub star history for ${fullName} week ${index} is invalid`);
    }
    const week = entry.week as number;
    const days = entry.days as number[];
    const total = entry.total as number;
    if (days.reduce((sum, count) => sum + count, 0) !== total) {
      throw new TypeError(`GitHub star history for ${fullName} week ${index} total does not match its days`);
    }
    if (week >= previousWeek) {
      throw new TypeError(`GitHub star history for ${fullName} must list weeks newest first`);
    }
    previousWeek = week;
    return { week, total, days };
  });
}

function flattenWeeks(weeks: readonly StarHistoryWeek[]): StarHistoryDay[] {
  const starts: Array<{ start: number; stars_added: number }> = [];
  [...weeks].reverse().forEach((entry) => {
    entry.days.forEach((count, index) => {
      starts.push({ start: (entry.week + index * 86_400) * 1000, stars_added: count });
    });
  });
  return starts.map((day, index) => {
    const next = starts[index + 1];
    const end = next === undefined ? day.start + DAY_MS : next.start;
    if (end <= day.start) {
      throw new TypeError("GitHub star history day buckets must be strictly increasing");
    }
    return {
      start: new Date(day.start).toISOString(),
      end: new Date(end).toISOString(),
      stars_added: day.stars_added,
    };
  });
}

async function fetchStargazerCount(
  fullName: string,
  token: string,
  fetchImplementation: typeof fetch,
): Promise<number> {
  const { owner, name } = requireFullName(fullName);
  const response = await fetchImplementation(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { headers: githubHeaders(token), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  requireResponseOk(response, `GitHub repository ${fullName}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Number.isInteger(payload.stargazers_count) || (payload.stargazers_count as number) < 0) {
    throw new TypeError(`GitHub repository ${fullName} returned an invalid stargazers_count`);
  }
  return payload.stargazers_count as number;
}

/**
 * Reads the GitHub star history for a repository back to `coverFrom` (or the
 * repository's creation week) together with the current stargazer count that
 * anchors the daily increments to absolute values.
 */
export async function fetchGitHubStarHistory({
  fullName,
  token,
  coverFrom,
  fetchImplementation = fetch,
  now = () => new Date(),
}: {
  fullName: string;
  token: string;
  coverFrom: string;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
}): Promise<GitHubStarHistory> {
  if (token.trim() === "") {
    throw new TypeError("GITHUB_TOKEN is required");
  }
  const { owner, name } = requireFullName(fullName);
  const coverFromTimestamp = requireTimestamp(coverFrom, "coverFrom");
  const fetchedAt = now().toISOString();
  const stars = await fetchStargazerCount(fullName, token, fetchImplementation);

  const weeks: StarHistoryWeek[] = [];
  let complete = false;
  for (let page = 1; page <= HISTORY_PAGE_LIMIT; page += 1) {
    const url = new URL(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/stargazers/history`,
    );
    url.search = new URLSearchParams({
      per_page: String(HISTORY_PAGE_WEEKS),
      page: String(page),
    }).toString();
    const response = await fetchImplementation(url, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    requireResponseOk(response, `GitHub star history ${fullName}`);
    const pageWeeks = parseStarHistoryPage(await response.json(), fullName);
    const lastWeek = weeks.at(-1);
    if (lastWeek !== undefined && pageWeeks.length > 0 && pageWeeks[0].week >= lastWeek.week) {
      throw new TypeError(`GitHub star history for ${fullName} page ${page} overlaps the previous page`);
    }
    weeks.push(...pageWeeks);
    if (pageWeeks.length < HISTORY_PAGE_WEEKS) {
      complete = true;
      break;
    }
    const oldestWeek = weeks.at(-1);
    if (oldestWeek !== undefined && oldestWeek.week * 1000 <= coverFromTimestamp) {
      break;
    }
  }

  // GitHub returns the whole current week, so days after the fetch time are
  // still in the future and must be empty. Only buckets up to the current
  // day are kept, and the current day anchors the running count.
  const fetchedTimestamp = Date.parse(fetchedAt);
  const allDays = flattenWeeks(weeks);
  const currentIndex = allDays.findIndex((day) => (
    Date.parse(day.start) <= fetchedTimestamp && fetchedTimestamp < Date.parse(day.end)
  ));
  if (currentIndex === -1 && (allDays.length > 0 || !complete)) {
    throw new StarHistoryLagError(fullName, fetchedAt);
  }
  if (allDays.slice(currentIndex + 1).some((day) => day.stars_added !== 0)) {
    throw new Error(`GitHub star history for ${fullName} reports stars after ${fetchedAt}`);
  }
  const days = currentIndex === -1 ? [] : allDays.slice(0, currentIndex + 1);
  return {
    schema_version: "1.0",
    full_name: fullName,
    fetched_at: fetchedAt,
    stars,
    complete,
    days,
  };
}

export function parseGitHubStarHistory(value: unknown): GitHubStarHistory {
  if (
    !isRecord(value)
    || value.schema_version !== "1.0"
    || typeof value.full_name !== "string"
    || typeof value.fetched_at !== "string"
    || !Number.isFinite(Date.parse(value.fetched_at))
    || !Number.isInteger(value.stars)
    || (value.stars as number) < 0
    || typeof value.complete !== "boolean"
    || !Array.isArray(value.days)
  ) {
    throw new TypeError("GitHub star history does not match schema version 1.0");
  }
  requireFullName(value.full_name);
  let previousEnd = Number.NEGATIVE_INFINITY;
  value.days.forEach((day, index) => {
    if (
      !isRecord(day)
      || typeof day.start !== "string"
      || typeof day.end !== "string"
      || !Number.isInteger(day.stars_added)
    ) {
      throw new TypeError(`GitHub star history day ${index} is invalid`);
    }
    const start = Date.parse(day.start);
    const end = Date.parse(day.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < previousEnd) {
      throw new TypeError(`GitHub star history day ${index} is invalid`);
    }
    previousEnd = end;
  });
  return value as GitHubStarHistory;
}

/**
 * Converts daily increments into absolute star counts at the end of each
 * completed day by walking backwards from the anchored current count.
 */
export function buildDayEndPoints(history: GitHubStarHistory): RepositoryStarPoint[] {
  const fetchedTimestamp = Date.parse(history.fetched_at);
  let running = history.stars;
  const points: RepositoryStarPoint[] = [];
  for (let index = history.days.length - 1; index >= 0; index -= 1) {
    const day = history.days[index];
    if (Date.parse(day.end) <= fetchedTimestamp) {
      if (running < 0) {
        throw new Error(`GitHub star history for ${history.full_name} produces a negative star count`);
      }
      points.push({ captured_at: day.end, stars: running });
    }
    running -= day.stars_added;
  }
  return points.reverse();
}

export function mergeStarSeries(
  observed: RepositoryStarSeries,
  history: GitHubStarHistory | null,
  before: string,
  windowDays: number = STAR_SERIES_WINDOW_DAYS,
): RepositoryStarSeries {
  if (history !== null && observed.full_name.toLowerCase() !== history.full_name.toLowerCase()) {
    throw new TypeError(`GitHub star history ${history.full_name} does not match ${observed.full_name}`);
  }
  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    throw new RangeError("windowDays must be a positive integer");
  }
  const beforeTimestamp = requireTimestamp(before, "before");
  const fromTimestamp = beforeTimestamp - windowDays * DAY_MS;
  const inWindow = (point: RepositoryStarPoint): boolean => {
    const timestamp = Date.parse(point.captured_at);
    return timestamp >= fromTimestamp && timestamp <= beforeTimestamp;
  };
  const observedPoints = observed.points.filter(inWindow);
  const observedTimestamps = new Set(observedPoints.map((point) => Date.parse(point.captured_at)));
  const historyPoints = (history === null ? [] : buildDayEndPoints(history))
    .filter(inWindow)
    .filter((point) => !observedTimestamps.has(Date.parse(point.captured_at)));
  const points = [...observedPoints, ...historyPoints]
    .sort((left, right) => Date.parse(left.captured_at) - Date.parse(right.captured_at))
    .map((point) => ({ captured_at: new Date(point.captured_at).toISOString(), stars: point.stars }));
  return { full_name: observed.full_name, points };
}

export type StarHistoryStoreOptions = {
  cacheDirectory: string;
  token: string;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
  ttlMs?: number;
};

/**
 * Disk cache in front of the GitHub star history endpoint. Completed days
 * never change, so a cached history is reused until its TTL expires or a
 * request needs coverage older than the cached range.
 */
export class StarHistoryStore {
  private readonly cacheDirectory: string;
  private readonly token: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly inFlight = new Map<string, Promise<GitHubStarHistory>>();

  constructor(options: StarHistoryStoreOptions) {
    if (options.token.trim() === "") {
      throw new TypeError("GITHUB_TOKEN is required");
    }
    if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
      throw new RangeError("ttlMs must be a positive number");
    }
    this.cacheDirectory = options.cacheDirectory;
    this.token = options.token;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  private cachePath(fullName: string): string {
    const key = createHash("sha256").update(fullName.toLowerCase()).digest("hex");
    return join(this.cacheDirectory, `${key}.json`);
  }

  private readCache(fullName: string): GitHubStarHistory | null {
    let raw: string;
    try {
      raw = readFileSync(this.cachePath(fullName), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const history = parseGitHubStarHistory(JSON.parse(raw));
    if (history.full_name.toLowerCase() !== fullName.toLowerCase()) {
      throw new Error(`Star history cache for ${fullName} contains ${history.full_name}`);
    }
    return history;
  }

  private writeCache(history: GitHubStarHistory): void {
    mkdirSync(this.cacheDirectory, { recursive: true });
    const path = this.cachePath(history.full_name);
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(history));
    renameSync(temporaryPath, path);
  }

  private covers(history: GitHubStarHistory, coverFrom: string): boolean {
    if (history.complete) {
      return true;
    }
    const oldest = history.days[0];
    return oldest !== undefined && Date.parse(oldest.start) <= Date.parse(coverFrom);
  }

  private isFresh(history: GitHubStarHistory): boolean {
    return this.now().getTime() - Date.parse(history.fetched_at) < this.ttlMs;
  }

  async read(fullName: string, coverFrom: string): Promise<GitHubStarHistory> {
    requireFullName(fullName);
    requireTimestamp(coverFrom, "coverFrom");
    const cached = this.readCache(fullName);
    if (cached !== null && this.isFresh(cached) && this.covers(cached, coverFrom)) {
      return cached;
    }
    const key = `${fullName.toLowerCase()}\n${coverFrom}`;
    const pending = this.inFlight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const request = (async () => {
      try {
        const history = await fetchGitHubStarHistory({
          fullName,
          token: this.token,
          coverFrom,
          fetchImplementation: this.fetchImplementation,
          now: this.now,
        });
        this.writeCache(history);
        return history;
      } catch (error) {
        if (cached !== null && this.covers(cached, coverFrom)) {
          process.stderr.write(
            `Serving stale star history for ${fullName}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          return cached;
        }
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, request);
    return request;
  }
}

/**
 * Extends every observed series with GitHub's daily star history inside the
 * chart window that ends at `before`.
 */
export async function enrichStarSeries(
  response: StarSeriesResponse,
  before: string,
  store: Pick<StarHistoryStore, "read">,
  windowDays: number = STAR_SERIES_WINDOW_DAYS,
): Promise<StarSeriesResponse> {
  const beforeTimestamp = requireTimestamp(before, "before");
  const coverFrom = new Date(beforeTimestamp - windowDays * DAY_MS).toISOString();
  const series = await Promise.all(response.series.map(async (observed) => {
    let history: GitHubStarHistory;
    try {
      history = await store.read(observed.full_name, coverFrom);
    } catch (error) {
      if (!(error instanceof StarHistoryLagError)) {
        throw error;
      }
      process.stderr.write(`${error.message}; serving observed star series only\n`);
      return mergeStarSeries(observed, null, before, windowDays);
    }
    return mergeStarSeries(observed, history, before, windowDays);
  }));
  return parseStarSeriesResponse({ schema_version: "1.0", series });
}
