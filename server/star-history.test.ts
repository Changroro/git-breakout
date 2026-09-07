import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildRetainedAcquisitionSeries,
  enrichStarSeries,
  fetchGitHubStarHistory,
  parseStarHistoryPage,
  collectStarHistories,
  DEFAULT_RATE_LIMIT_RESERVE,
  GitHubRateLimitError,
  GitHubRequestError,
  readCoreRateLimit,
  starHistoryFetchBudget,
  STAR_HISTORY_CALLS_PER_REPOSITORY,
  RANKING_HISTORY_WINDOW_DAYS,
  StarHistoryStore,
  summarizeStarHistory,
  type GitHubStarHistory,
} from "./star-history.ts";

const DAY_SECONDS = 86_400;
// Sunday 2026-08-30T00:00:00Z and the week before it.
const WEEK_CURRENT = 1_788_048_000;
const WEEK_PREVIOUS = WEEK_CURRENT - 7 * DAY_SECONDS;
const NOW = new Date("2026-09-05T12:00:00.000Z");

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function historyResponse(weeks: unknown[]): Response {
  return jsonResponse(weeks);
}

function routedFetch(routes: Record<string, () => Response>): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const route = routes[url];
    if (route === undefined) {
      throw new Error(`Unexpected fetch ${url}`);
    }
    return route();
  });
}

const REPOSITORY_URL = "https://api.github.com/repos/owner/repository";
const HISTORY_URL = `${REPOSITORY_URL}/stargazers/history?per_page=30&page=1`;
const HISTORY_PAGE_2_URL = `${REPOSITORY_URL}/stargazers/history?per_page=30&page=2`;

const sampleWeeks = [
  // Current week: Sun 8/30 .. Sat 9/5. Saturday (today) is in progress with 4 stars so far.
  { week: WEEK_CURRENT, total: 1 + 2 + 3 + 0 + 5 + 6 + 4, days: [1, 2, 3, 0, 5, 6, 4] },
  { week: WEEK_PREVIOUS, total: 7, days: [1, 1, 1, 1, 1, 1, 1] },
];

describe("parseStarHistoryPage", () => {
  it("accepts weeks listed newest first", () => {
    expect(parseStarHistoryPage(sampleWeeks, "owner/repository")).toEqual(sampleWeeks);
  });

  it("rejects malformed weeks", () => {
    expect(() => parseStarHistoryPage([{ week: WEEK_CURRENT, total: 1, days: [1, 0, 0] }], "owner/repository"))
      .toThrow(TypeError);
    expect(() => parseStarHistoryPage([{ week: WEEK_CURRENT, total: 2, days: [1, 0, 0, 0, 0, 0, 0] }], "owner/repository"))
      .toThrow("total does not match");
    expect(() => parseStarHistoryPage([{ week: WEEK_CURRENT, total: 0, days: [-1, 1, 0, 0, 0, 0, 0] }], "owner/repository"))
      .toThrow(TypeError);
    expect(() => parseStarHistoryPage([...sampleWeeks].reverse(), "owner/repository"))
      .toThrow("newest first");
    expect(() => parseStarHistoryPage({ weeks: [] }, "owner/repository")).toThrow(TypeError);
  });
});

describe("fetchGitHubStarHistory", () => {
  it("reads retained-star acquisition buckets without treating them as historical totals", async () => {
    const fetchImplementation = routedFetch({
      [HISTORY_URL]: () => historyResponse(sampleWeeks),
    });

    const history = await fetchGitHubStarHistory({
      fullName: "owner/repository",
      token: "token",
      coverFrom: "2026-08-24T00:00:00.000Z",
      fetchImplementation,
      now: () => NOW,
    });

    expect(history).toMatchObject({
      schema_version: "1.0",
      full_name: "owner/repository",
      fetched_at: NOW.toISOString(),
      complete: true,
    });
    expect(history.days).toHaveLength(14);
    expect(history.days[0]).toEqual({
      start: "2026-08-23T00:00:00.000Z",
      end: "2026-08-24T00:00:00.000Z",
      stars_added: 1,
    });
    expect(history.days[13]).toEqual({
      start: "2026-09-05T00:00:00.000Z",
      end: "2026-09-06T00:00:00.000Z",
      stars_added: 4,
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fetchImplementation).toHaveBeenCalledWith(
      expect.objectContaining({ href: HISTORY_URL }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "X-GitHub-Api-Version": "2026-03-10",
        }),
      }),
    );
  });

  it("pages backwards until the requested coverage is reached", async () => {
    const fullPage = Array.from({ length: 30 }, (_, index) => ({
      week: WEEK_CURRENT - index * 7 * DAY_SECONDS,
      total: 7,
      days: [1, 1, 1, 1, 1, 1, 1],
    }));
    const olderPage = Array.from({ length: 30 }, (_, index) => ({
      week: WEEK_CURRENT - (30 + index) * 7 * DAY_SECONDS,
      total: 0,
      days: [0, 0, 0, 0, 0, 0, 0],
    }));
    const fetchImplementation = routedFetch({
      [HISTORY_URL]: () => historyResponse(fullPage),
      [HISTORY_PAGE_2_URL]: () => historyResponse(olderPage),
    });

    const history = await fetchGitHubStarHistory({
      fullName: "owner/repository",
      token: "token",
      coverFrom: new Date((WEEK_CURRENT - 31 * 7 * DAY_SECONDS) * 1000).toISOString(),
      fetchImplementation,
      now: () => NOW,
    });

    expect(history.days).toHaveLength(60 * 7);
    expect(history.complete).toBe(false);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("stops paging once the coverage window is satisfied", async () => {
    const fullPage = Array.from({ length: 30 }, (_, index) => ({
      week: WEEK_CURRENT - index * 7 * DAY_SECONDS,
      total: 0,
      days: [0, 0, 0, 0, 0, 0, 0],
    }));
    const fetchImplementation = routedFetch({
      [HISTORY_URL]: () => historyResponse(fullPage),
    });

    const history = await fetchGitHubStarHistory({
      fullName: "owner/repository",
      token: "token",
      coverFrom: "2026-06-07T12:00:00.000Z",
      fetchImplementation,
      now: () => NOW,
    });

    expect(history.complete).toBe(false);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("preserves GitHub-defined buckets so consumers can select completed days", async () => {
    const fetchImplementation = routedFetch({
      [HISTORY_URL]: () => historyResponse([
        { week: WEEK_CURRENT, total: 3, days: [1, 2, 0, 0, 0, 0, 0] },
      ]),
    });

    const history = await fetchGitHubStarHistory({
      fullName: "owner/repository",
      token: "token",
      coverFrom: "2026-08-24T00:00:00.000Z",
      fetchImplementation,
      now: () => new Date("2026-08-31T09:00:00.000Z"),
    });

    expect(history.days).toHaveLength(7);
    expect(history.days.slice(0, 2)).toEqual([
      { start: "2026-08-30T00:00:00.000Z", end: "2026-08-31T00:00:00.000Z", stars_added: 1 },
      { start: "2026-08-31T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z", stars_added: 2 },
    ]);
  });

  it("rejects stars reported for days after the fetch time", async () => {
    const fetchImplementation = routedFetch({
      [HISTORY_URL]: () => historyResponse([
        { week: WEEK_CURRENT, total: 3, days: [1, 0, 2, 0, 0, 0, 0] },
      ]),
    });

    await expect(fetchGitHubStarHistory({
      fullName: "owner/repository",
      token: "token",
      coverFrom: "2026-08-24T00:00:00.000Z",
      fetchImplementation,
      now: () => new Date("2026-08-31T09:00:00.000Z"),
    })).rejects.toThrow("reports stars after");
  });

  it("accepts a history response whose newest bucket predates the fetch", async () => {
    const fetchImplementation = routedFetch({
      [HISTORY_URL]: () => historyResponse([sampleWeeks[1]]),
    });

    await expect(fetchGitHubStarHistory({
      fullName: "owner/repository",
      token: "token",
      coverFrom: "2026-08-24T00:00:00.000Z",
      fetchImplementation,
      now: () => NOW,
    })).resolves.toMatchObject({ days: expect.any(Array) });
  });

  it("reports GitHub failures with the rate limit reset time", async () => {
    const fetchImplementation = routedFetch({
      [HISTORY_URL]: () => jsonResponse({ message: "rate limited" }, {
        status: 403,
        headers: { "x-ratelimit-reset": "1788656180" },
      }),
    });

    await expect(fetchGitHubStarHistory({
      fullName: "owner/repository",
      token: "token",
      coverFrom: "2026-08-24T00:00:00.000Z",
      fetchImplementation,
      now: () => NOW,
    })).rejects.toThrow("status 403; rate limit resets at 2026-09-06T00:56:20.000Z");
  });

  it("raises a typed error once the hourly quota is spent", async () => {
    const fetchImplementation = routedFetch({
      [HISTORY_URL]: () => jsonResponse({ message: "rate limited" }, {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1788656180" },
      }),
    });

    await expect(fetchGitHubStarHistory({
      fullName: "owner/repository",
      token: "token",
      coverFrom: "2026-08-24T00:00:00.000Z",
      fetchImplementation,
      now: () => NOW,
    })).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it("rejects invalid repository names and empty tokens", async () => {
    await expect(fetchGitHubStarHistory({
      fullName: "owner",
      token: "token",
      coverFrom: "2026-08-24T00:00:00.000Z",
    })).rejects.toThrow(TypeError);
    await expect(fetchGitHubStarHistory({
      fullName: "owner/repository",
      token: " ",
      coverFrom: "2026-08-24T00:00:00.000Z",
    })).rejects.toThrow("GITHUB_TOKEN is required");
  });
});

function sampleHistory(): GitHubStarHistory {
  return {
    schema_version: "1.0",
    full_name: "owner/repository",
    fetched_at: NOW.toISOString(),
    complete: true,
    days: [
      { start: "2026-09-02T00:00:00.000Z", end: "2026-09-03T00:00:00.000Z", stars_added: 10 },
      { start: "2026-09-03T00:00:00.000Z", end: "2026-09-04T00:00:00.000Z", stars_added: 20 },
      { start: "2026-09-04T00:00:00.000Z", end: "2026-09-05T00:00:00.000Z", stars_added: 30 },
      { start: "2026-09-05T00:00:00.000Z", end: "2026-09-06T00:00:00.000Z", stars_added: 4 },
    ],
  };
}

describe("buildRetainedAcquisitionSeries", () => {
  it("builds a zero-based cumulative series from completed retained-star buckets", () => {
    expect(buildRetainedAcquisitionSeries(
      sampleHistory(),
      "2026-09-05T02:00:00.000Z",
      2,
    )).toEqual({
      full_name: "owner/repository",
      source: "github_retained_acquisitions",
      points: [
        { captured_at: "2026-09-03T00:00:00.000Z", stars: 0 },
        { captured_at: "2026-09-04T00:00:00.000Z", stars: 20 },
        { captured_at: "2026-09-05T00:00:00.000Z", stars: 50 },
      ],
    });
  });
});

describe("StarHistoryStore", () => {
  it("caches fetched history on disk and reuses it while fresh", async () => {
    const cacheDirectory = join(mkdtempSync(join(tmpdir(), "star-history-")), "cache");
    const fetchImplementation = routedFetch({
      [HISTORY_URL]: () => historyResponse(sampleWeeks),
    });
    const store = new StarHistoryStore({
      cacheDirectory,
      token: "token",
      fetchImplementation,
      now: () => NOW,
    });

    const first = await store.read("owner/repository", "2026-08-24T00:00:00.000Z");
    const second = await store.read("Owner/Repository", "2026-08-24T00:00:00.000Z");

    expect(second).toEqual(first);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(readdirSync(cacheDirectory)).toHaveLength(1);
  });

  it("refetches when the cache is stale and falls back to it when GitHub fails", async () => {
    const cacheDirectory = join(mkdtempSync(join(tmpdir(), "star-history-")), "cache");
    let current = NOW;
    let failing = false;
    const fetchImplementation = routedFetch({
      [HISTORY_URL]: () => failing
        ? jsonResponse({ message: "down" }, { status: 502 })
        : historyResponse(sampleWeeks),
    });
    const store = new StarHistoryStore({
      cacheDirectory,
      token: "token",
      fetchImplementation,
      now: () => current,
      ttlMs: 60_000,
    });
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const fresh = await store.read("owner/repository", "2026-08-24T00:00:00.000Z");
    current = new Date(NOW.getTime() + 120_000);
    failing = true;
    const stale = await store.read("owner/repository", "2026-08-24T00:00:00.000Z");

    expect(stale).toEqual(fresh);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("Serving stale star history"));
    errors.mockRestore();
  });

  it("spreads expiry with stable per-repository jitter", async () => {
    const cacheDirectory = join(mkdtempSync(join(tmpdir(), "star-history-")), "cache");
    let current = NOW;
    const fetchImplementation = routedFetch({
      [HISTORY_URL]: () => historyResponse(sampleWeeks),
    });
    const store = new StarHistoryStore({
      cacheDirectory,
      token: "token",
      fetchImplementation,
      now: () => current,
      ttlMs: 100_000,
      ttlJitterMs: 50_000,
    });

    await store.read("owner/repository", "2026-08-24T00:00:00.000Z");
    current = new Date(NOW.getTime() + 49_000);
    await store.read("owner/repository", "2026-08-24T00:00:00.000Z");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    current = new Date(NOW.getTime() + 100_000);
    await store.read("owner/repository", "2026-08-24T00:00:00.000Z");
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(() => new StarHistoryStore({
      cacheDirectory,
      token: "token",
      ttlMs: 1_000,
      ttlJitterMs: 1_000,
    })).toThrow(RangeError);
    expect(() => new StarHistoryStore({
      cacheDirectory,
      token: "token",
      hourlyRequestLimit: DEFAULT_RATE_LIMIT_RESERVE + 1,
    })).toThrow("between 1 and 500");
  });

  it("surfaces GitHub failures when nothing is cached", async () => {
    const cacheDirectory = join(mkdtempSync(join(tmpdir(), "star-history-")), "cache");
    const store = new StarHistoryStore({
      cacheDirectory,
      token: "token",
      fetchImplementation: routedFetch({
        [HISTORY_URL]: () => jsonResponse({ message: "missing" }, { status: 404 }),
      }),
      now: () => NOW,
    });

    await expect(store.read("owner/repository", "2026-08-24T00:00:00.000Z"))
      .rejects.toThrow("status 404");
  });
});

describe("enrichStarSeries", () => {
  it("serves observed totals when GitHub history is unavailable", async () => {
    const read = vi.fn(async () => {
      throw new GitHubRequestError(
        "GitHub repository owner/repository request failed with status 502",
      );
    });
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const response = await enrichStarSeries(
      {
        schema_version: "1.0",
        series: [{
          full_name: "owner/repository",
          points: [
            { captured_at: "2026-09-04T02:00:00.000Z", stars: 70 },
            { captured_at: "2026-09-05T02:00:00.000Z", stars: 97 },
          ],
        }],
      },
      "2026-09-05T02:00:00.000Z",
      { read },
      2,
    );

    expect(response.series[0]).toEqual({
      full_name: "owner/repository",
      source: "observed",
      points: [
        { captured_at: "2026-09-04T02:00:00.000Z", stars: 70 },
        { captured_at: "2026-09-05T02:00:00.000Z", stars: 97 },
      ],
    });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("serving observed totals"));
    errors.mockRestore();
  });

  it("fails loudly when history data is invalid", async () => {
    const read = vi.fn(async () => {
      throw new TypeError("GitHub star history response is invalid");
    });

    await expect(enrichStarSeries(
      { schema_version: "1.0", series: [{ full_name: "owner/repository", points: [] }] },
      "2026-09-05T02:00:00.000Z",
      { read },
    )).rejects.toThrow("response is invalid");
  });

  it("uses retained acquisitions without mixing in observed totals", async () => {
    const read = vi.fn(async () => sampleHistory());
    const response = await enrichStarSeries(
      {
        schema_version: "1.0",
        series: [{
          full_name: "owner/repository",
          points: [{ captured_at: "2026-09-05T02:00:00.000Z", stars: 97 }],
        }],
      },
      "2026-09-05T02:00:00.000Z",
      { read },
      2,
    );

    expect(response).toEqual({
      schema_version: "1.0",
      series: [{
        full_name: "owner/repository",
        source: "github_retained_acquisitions",
        points: [
          { captured_at: "2026-09-03T00:00:00.000Z", stars: 0 },
          { captured_at: "2026-09-04T00:00:00.000Z", stars: 20 },
          { captured_at: "2026-09-05T00:00:00.000Z", stars: 50 },
        ],
      }],
    });
    expect(read).toHaveBeenCalledWith("owner/repository", "2026-09-03T02:00:00.000Z");
  });
});

describe("summarizeStarHistory", () => {
  it("keeps completed retained-star buckets inside the ranking window", () => {
    const summary = summarizeStarHistory(sampleHistory(), "2026-09-05T02:00:00.000Z", 2);

    expect(summary).toEqual({
      full_name: "owner/repository",
      captured_at: "2026-09-05T02:00:00.000Z",
      days: [
        {
          start: "2026-09-03T00:00:00.000Z",
          end: "2026-09-04T00:00:00.000Z",
          retained_stars_added: 20,
        },
        {
          start: "2026-09-04T00:00:00.000Z",
          end: "2026-09-05T00:00:00.000Z",
          retained_stars_added: 30,
        },
      ],
    });
    expect(RANKING_HISTORY_WINDOW_DAYS).toBe(98);
  });

  it("anchors at the fetch time when the history is older than the capture", () => {
    const summary = summarizeStarHistory(sampleHistory(), "2026-09-06T02:00:00.000Z");

    expect(summary.captured_at).toBe(NOW.toISOString());
    expect(summary.days.at(-1)).toEqual({
      start: "2026-09-04T00:00:00.000Z",
      end: "2026-09-05T00:00:00.000Z",
      retained_stars_added: 30,
    });
  });
});

describe("readCoreRateLimit and starHistoryFetchBudget", () => {
  it("reads the core resource and converts it into a repository budget", async () => {
    const fetchImplementation = routedFetch({
      "https://api.github.com/rate_limit": () => jsonResponse({
        resources: { core: { limit: 5_000, remaining: 4_100, used: 900, reset: 1_788_656_180 } },
      }),
    });

    const rateLimit = await readCoreRateLimit("token", fetchImplementation);

    expect(rateLimit).toEqual({
      limit: 5_000,
      remaining: 4_100,
      reset_at: "2026-09-06T00:56:20.000Z",
    });
    expect(STAR_HISTORY_CALLS_PER_REPOSITORY).toBe(1);
    expect(starHistoryFetchBudget(rateLimit)).toBe(4_100 - DEFAULT_RATE_LIMIT_RESERVE);
    expect(starHistoryFetchBudget(rateLimit, 100)).toBe(4_000);
  });

  it("never returns a negative budget and rejects an invalid reserve", () => {
    const rateLimit = { limit: 5_000, remaining: 120, reset_at: "2026-09-06T00:56:20.000Z" };

    expect(starHistoryFetchBudget(rateLimit)).toBe(0);
    expect(starHistoryFetchBudget(rateLimit, 100)).toBe(20);
    expect(() => starHistoryFetchBudget(rateLimit, -1)).toThrow(RangeError);
  });

  it("rejects a response without a valid core resource", async () => {
    const fetchImplementation = routedFetch({
      "https://api.github.com/rate_limit": () => jsonResponse({ resources: { search: {} } }),
    });

    await expect(readCoreRateLimit("token", fetchImplementation)).rejects.toThrow("core resource");
  });
});

describe("collectStarHistories", () => {
  function reader(options: {
    cached?: Record<string, { fetchedAt: string; fresh: boolean }>;
    failing?: readonly string[];
    rateLimitedAt?: string;
  } = {}) {
    const cached = options.cached ?? {};
    const read = vi.fn(async (fullName: string) => {
      if (fullName === options.rateLimitedAt) {
        throw new GitHubRateLimitError(`GitHub repository ${fullName}`, 403, NOW);
      }
      if (options.failing?.includes(fullName) === true) {
        throw new Error(`GitHub repository ${fullName} request failed with status 404`);
      }
      return { ...sampleHistory(), full_name: fullName };
    });
    const readCached = vi.fn((fullName: string) => {
      const entry = cached[fullName];
      if (entry === undefined) {
        return null;
      }
      return {
        history: { ...sampleHistory(), full_name: fullName, fetched_at: entry.fetchedAt },
        fresh: entry.fresh,
      };
    });
    return { read, readCached };
  }

  const options = { capturedAt: "2026-09-05T02:00:00.000Z", concurrency: 2 } as const;

  it("serves fresh cache without spending budget", async () => {
    const store = reader({
      cached: {
        "owner/a": { fetchedAt: NOW.toISOString(), fresh: true },
        "owner/b": { fetchedAt: NOW.toISOString(), fresh: true },
      },
    });

    const collection = await collectStarHistories(["owner/a", "owner/b"], store, {
      ...options,
      fetchBudget: 0,
    });

    expect(collection.histories.map((history) => history.full_name)).toEqual(["owner/a", "owner/b"]);
    expect(collection).toMatchObject({ fetched: 0, reused: 2, skipped: 0 });
    expect(store.read).not.toHaveBeenCalled();
  });

  it("spends the budget on repositories with no history, then the stalest", async () => {
    const store = reader({
      cached: {
        "owner/recent": { fetchedAt: "2026-09-04T00:00:00.000Z", fresh: false },
        "owner/stale": { fetchedAt: "2026-09-01T00:00:00.000Z", fresh: false },
        "owner/fresh": { fetchedAt: NOW.toISOString(), fresh: true },
      },
    });

    const collection = await collectStarHistories(
      ["owner/recent", "owner/fresh", "owner/stale", "owner/unknown"],
      store,
      { ...options, fetchBudget: 2 },
    );

    expect(store.read.mock.calls.map((call) => call[0]).sort()).toEqual(["owner/stale", "owner/unknown"]);
    expect(collection).toMatchObject({ fetched: 2, reused: 2, skipped: 0 });
    expect(collection.histories).toHaveLength(4);
  });

  it("keeps deferred repositories on their stale history and skips the rest", async () => {
    const store = reader({
      cached: { "owner/stale": { fetchedAt: "2026-09-01T00:00:00.000Z", fresh: false } },
    });

    const collection = await collectStarHistories(["owner/stale", "owner/unknown"], store, {
      ...options,
      fetchBudget: 1,
    });

    expect(store.read).toHaveBeenCalledTimes(1);
    expect(store.read).toHaveBeenCalledWith("owner/unknown", "2026-05-30T02:00:00.000Z");
    expect(collection.histories.map((history) => history.full_name).sort())
      .toEqual(["owner/stale", "owner/unknown"]);
    expect(collection).toMatchObject({ fetched: 1, reused: 1, skipped: 0 });
  });

  it("records repositories it can neither fetch nor read from cache as skipped", async () => {
    const store = reader({ failing: ["owner/missing"] });
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const collection = await collectStarHistories(
      ["owner/a", "owner/missing", "owner/b"],
      store,
      { ...options, fetchBudget: 10 },
    );

    expect(collection.histories.map((history) => history.full_name)).toEqual(["owner/a", "owner/b"]);
    expect(collection).toMatchObject({ fetched: 2, reused: 0, skipped: 1 });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("Skipping star history for owner/missing"));
    errors.mockRestore();
  });

  it("collects with bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    const store = reader();
    store.read.mockImplementation(async (fullName: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { ...sampleHistory(), full_name: fullName };
    });

    await collectStarHistories(["owner/a", "owner/b", "owner/c", "owner/d"], store, {
      ...options,
      fetchBudget: 10,
    });

    expect(peak).toBe(2);
  });

  it("stops requesting once GitHub reports the quota as spent", async () => {
    const store = reader({ rateLimitedAt: "owner/b" });
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const collection = await collectStarHistories(
      ["owner/a", "owner/b", "owner/c", "owner/d"],
      store,
      { capturedAt: options.capturedAt, concurrency: 1, fetchBudget: 10 },
    );

    expect(collection.histories.map((history) => history.full_name)).toEqual(["owner/a"]);
    expect(store.read).toHaveBeenCalledTimes(2);
    expect(collection.skipped).toBe(3);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("Stopping star history collection after owner/b"));
    errors.mockRestore();
  });

  it("fails the run when every attempted repository failed", async () => {
    const store = reader({ failing: ["owner/a", "owner/b"] });
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(collectStarHistories(["owner/a", "owner/b"], store, {
      ...options,
      fetchBudget: 10,
    })).rejects.toThrow("failed for all 2 attempted repositories");
    errors.mockRestore();
  });

  it("does not fail when the budget deliberately allows no fetches", async () => {
    const store = reader();
    const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const collection = await collectStarHistories(["owner/a", "owner/b"], store, {
      ...options,
      fetchBudget: 0,
    });

    expect(collection).toEqual({ histories: [], fetched: 0, reused: 0, skipped: 2 });
    expect(store.read).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("2 deferred to a later run"));
    expect(await collectStarHistories([], store, { ...options, fetchBudget: 0 }))
      .toMatchObject({ histories: [] });
    await expect(collectStarHistories(["owner/a"], store, { ...options, fetchBudget: -1 }))
      .rejects.toThrow(RangeError);
    errors.mockRestore();
  });
});
