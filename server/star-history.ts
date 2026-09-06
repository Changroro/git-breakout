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
import {
  BREAKOUT_HISTORY_WEEKS,
  type RepositoryStarHistory,
} from "../src/lib/trend-intelligence.ts";

const DAY_MS = 86_400_000;
/** Days of completed history handed to the ranking: the compared weeks plus slack. */
export const RANKING_HISTORY_WINDOW_DAYS = (BREAKOUT_HISTORY_WEEKS + 2) * 7;
const DEFAULT_COLLECTION_CONCURRENCY = 4;
/** REST calls one repository costs: the stargazer count plus one history page. */
export const STAR_HISTORY_CALLS_PER_REPOSITORY = 2;
/** Core calls left untouched so star history never consumes the whole quota. */
export const DEFAULT_RATE_LIMIT_RESERVE = 500;
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

/** GitHub refused the request because the token's hourly quota is spent. */
export class GitHubRateLimitError extends Error {
  readonly resetAt: Date | null;

  constructor(source: string, status: number, resetAt: Date | null) {
    super(`${source} request failed with status ${status}; rate limit resets at ${resetAt?.toISOString() ?? "an unknown time"}`);
    this.name = "GitHubRateLimitError";
    this.resetAt = resetAt;
  }
}

function requireResponseOk(response: Response, source: string): void {
  if (response.ok) {
    return;
  }
  const resetHeader = response.headers.get("x-ratelimit-reset");
  const parsedReset = resetHeader === null ? null : new Date(Number(resetHeader) * 1000);
  const resetAt = parsedReset !== null && Number.isFinite(parsedReset.getTime()) ? parsedReset : null;
  if (
    (response.status === 403 || response.status === 429)
    && response.headers.get("x-ratelimit-remaining") === "0"
  ) {
    throw new GitHubRateLimitError(source, response.status, resetAt);
  }
  const resetMessage = resetAt === null ? "" : `; rate limit resets at ${resetAt.toISOString()}`;
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

export type CoreRateLimit = {
  limit: number;
  remaining: number;
  reset_at: string;
};

/**
 * Reads the token's remaining core quota. This endpoint is itself exempt from
 * the rate limit, so it can always be called before deciding a budget.
 */
export async function readCoreRateLimit(
  token: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<CoreRateLimit> {
  if (token.trim() === "") {
    throw new TypeError("GITHUB_TOKEN is required");
  }
  const response = await fetchImplementation("https://api.github.com/rate_limit", {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  requireResponseOk(response, "GitHub rate limit");
  const payload: unknown = await response.json();
  const core = isRecord(payload) && isRecord(payload.resources) ? payload.resources.core : undefined;
  if (
    !isRecord(core)
    || !Number.isInteger(core.limit)
    || !Number.isInteger(core.remaining)
    || !Number.isInteger(core.reset)
    || (core.remaining as number) < 0
  ) {
    throw new TypeError("GitHub rate limit response is missing a valid core resource");
  }
  return {
    limit: core.limit as number,
    remaining: core.remaining as number,
    reset_at: new Date((core.reset as number) * 1000).toISOString(),
  };
}

/**
 * Repositories that may be refreshed from GitHub in this run. Everything the
 * budget does not cover is served from cache or left out entirely, so a run
 * never spends more of the quota than it actually has.
 */
export function starHistoryFetchBudget(
  rateLimit: CoreRateLimit,
  reserve: number = DEFAULT_RATE_LIMIT_RESERVE,
): number {
  if (!Number.isInteger(reserve) || reserve < 0) {
    throw new RangeError("reserve must be a non-negative integer");
  }
  return Math.max(
    0,
    Math.floor((rateLimit.remaining - reserve) / STAR_HISTORY_CALLS_PER_REPOSITORY),
  );
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
  /**
   * Shortens each repository's TTL by a stable, repository-specific amount up
   * to this value so a large cache does not expire all at once.
   */
  ttlJitterMs?: number;
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
  private readonly ttlJitterMs: number;
  private readonly inFlight = new Map<string, Promise<GitHubStarHistory>>();

  constructor(options: StarHistoryStoreOptions) {
    if (options.token.trim() === "") {
      throw new TypeError("GITHUB_TOKEN is required");
    }
    if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)) {
      throw new RangeError("ttlMs must be a positive number");
    }
    const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    const ttlJitterMs = options.ttlJitterMs ?? 0;
    if (!Number.isFinite(ttlJitterMs) || ttlJitterMs < 0 || ttlJitterMs >= ttlMs) {
      throw new RangeError("ttlJitterMs must be non-negative and smaller than ttlMs");
    }
    this.cacheDirectory = options.cacheDirectory;
    this.token = options.token;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = ttlMs;
    this.ttlJitterMs = ttlJitterMs;
  }

  private cacheKey(fullName: string): string {
    return createHash("sha256").update(fullName.toLowerCase()).digest("hex");
  }

  private cachePath(fullName: string): string {
    return join(this.cacheDirectory, `${this.cacheKey(fullName)}.json`);
  }

  private ttlFor(fullName: string): number {
    if (this.ttlJitterMs === 0) {
      return this.ttlMs;
    }
    const jitter = Number.parseInt(this.cacheKey(fullName).slice(0, 8), 16) % Math.floor(this.ttlJitterMs);
    return this.ttlMs - jitter;
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
    return this.now().getTime() - Date.parse(history.fetched_at) < this.ttlFor(history.full_name);
  }

  /**
   * Returns the cached history when it covers the window, without contacting
   * GitHub. `fresh` reports whether it is still inside its TTL; a stale entry
   * is still usable when there is no budget left to refresh it.
   */
  readCached(
    fullName: string,
    coverFrom: string,
  ): { history: GitHubStarHistory; fresh: boolean } | null {
    requireFullName(fullName);
    requireTimestamp(coverFrom, "coverFrom");
    const cached = this.readCache(fullName);
    if (cached === null || !this.covers(cached, coverFrom)) {
      return null;
    }
    return { history: cached, fresh: this.isFresh(cached) };
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

/**
 * Reduces a fetched history to the completed day-end points the ranking
 * needs, ending no later than `capturedAt`.
 */
export function summarizeStarHistory(
  history: GitHubStarHistory,
  capturedAt: string,
  windowDays: number = RANKING_HISTORY_WINDOW_DAYS,
): RepositoryStarHistory {
  const capturedTimestamp = requireTimestamp(capturedAt, "capturedAt");
  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    throw new RangeError("windowDays must be a positive integer");
  }
  const anchoredAt = Math.min(capturedTimestamp, Date.parse(history.fetched_at));
  const from = anchoredAt - windowDays * DAY_MS;
  const dayEnds = buildDayEndPoints(history).filter((point) => {
    const timestamp = Date.parse(point.captured_at);
    return timestamp >= from && timestamp <= anchoredAt;
  });
  return {
    full_name: history.full_name,
    captured_at: new Date(anchoredAt).toISOString(),
    day_ends: dayEnds,
  };
}

export type StarHistoryCollection = {
  histories: RepositoryStarHistory[];
  /** Repositories refreshed from GitHub in this run. */
  fetched: number;
  /** Repositories served from cache without spending quota. */
  reused: number;
  /** Repositories left without history: no cache and no budget, or an error. */
  skipped: number;
};

type StarHistoryReader = Pick<StarHistoryStore, "read" | "readCached">;

/**
 * Loads star history for a collection run inside a fixed fetch budget.
 *
 * Cached histories that still cover the window cost nothing, so only the
 * repositories that actually need a refresh compete for the budget; the ones
 * missing history entirely go first, then the stalest. Anything beyond the
 * budget falls back to its cached history, or is skipped so the ranking
 * records it as missing evidence. Skipped repositories are not carried over
 * to the next run as debt: each run simply refreshes what it can afford.
 */
export async function collectStarHistories(
  fullNames: readonly string[],
  store: StarHistoryReader,
  {
    capturedAt,
    fetchBudget,
    windowDays = RANKING_HISTORY_WINDOW_DAYS,
    concurrency = DEFAULT_COLLECTION_CONCURRENCY,
  }: {
    capturedAt: string;
    fetchBudget: number;
    windowDays?: number;
    concurrency?: number;
  },
): Promise<StarHistoryCollection> {
  const capturedTimestamp = requireTimestamp(capturedAt, "capturedAt");
  if (!Number.isInteger(fetchBudget) || fetchBudget < 0) {
    throw new RangeError("fetchBudget must be a non-negative integer");
  }
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new RangeError("concurrency must be a positive integer");
  }
  const coverFrom = new Date(capturedTimestamp - windowDays * DAY_MS).toISOString();
  const results: Array<RepositoryStarHistory | null> = new Array(fullNames.length).fill(null);
  const refreshable: Array<{ index: number; fullName: string; cachedAt: number }> = [];
  let reused = 0;

  fullNames.forEach((fullName, index) => {
    let cached: { history: GitHubStarHistory; fresh: boolean } | null = null;
    try {
      cached = store.readCached(fullName, coverFrom);
    } catch (error) {
      process.stderr.write(
        `Discarding unreadable star history cache for ${fullName}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    if (cached !== null && cached.fresh) {
      results[index] = summarizeStarHistory(cached.history, capturedAt, windowDays);
      reused += 1;
      return;
    }
    refreshable.push({
      index,
      fullName,
      cachedAt: cached === null ? Number.NEGATIVE_INFINITY : Date.parse(cached.history.fetched_at),
    });
  });

  // Repositories with no usable history at all come first, then the stalest.
  refreshable.sort((left, right) => (
    left.cachedAt - right.cachedAt || left.fullName.localeCompare(right.fullName)
  ));
  const selected = refreshable.slice(0, fetchBudget);
  const deferred = refreshable.slice(fetchBudget);

  let next = 0;
  let fetched = 0;
  let rateLimited = false;
  async function worker(): Promise<void> {
    while (next < selected.length && !rateLimited) {
      const entry = selected[next];
      next += 1;
      try {
        results[entry.index] = summarizeStarHistory(
          await store.read(entry.fullName, coverFrom),
          capturedAt,
          windowDays,
        );
        fetched += 1;
      } catch (error) {
        if (error instanceof GitHubRateLimitError && !rateLimited) {
          rateLimited = true;
          process.stderr.write(
            `Stopping star history collection after ${entry.fullName}: ${error.message}; ${selected.length - next} refreshes skipped\n`,
          );
          return;
        }
        process.stderr.write(
          `Skipping star history for ${entry.fullName}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()),
  );

  // Anything the budget did not cover keeps its stale history rather than
  // losing the signal entirely.
  [...deferred, ...selected.slice(next)].forEach((entry) => {
    if (results[entry.index] !== null || entry.cachedAt === Number.NEGATIVE_INFINITY) {
      return;
    }
    const cached = store.readCached(entry.fullName, coverFrom);
    if (cached !== null) {
      results[entry.index] = summarizeStarHistory(cached.history, capturedAt, windowDays);
      reused += 1;
    }
  });

  const histories = results.filter((history): history is RepositoryStarHistory => history !== null);
  if (selected.length > 0 && fetched === 0 && histories.length === 0) {
    throw new Error(`Star history collection failed for all ${selected.length} attempted repositories`);
  }
  if (deferred.length > 0) {
    process.stderr.write(
      `Star history budget covered ${selected.length} of ${refreshable.length} refreshes; ${deferred.length} deferred to a later run\n`,
    );
  }
  return {
    histories,
    fetched,
    reused,
    skipped: fullNames.length - histories.length,
  };
}
