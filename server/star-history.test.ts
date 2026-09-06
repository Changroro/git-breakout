import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildDayEndPoints,
  enrichStarSeries,
  fetchGitHubStarHistory,
  mergeStarSeries,
  parseStarHistoryPage,
  StarHistoryLagError,
  StarHistoryStore,
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
    expect(() => parseStarHistoryPage([...sampleWeeks].reverse(), "owner/repository"))
      .toThrow("newest first");
    expect(() => parseStarHistoryPage({ weeks: [] }, "owner/repository")).toThrow(TypeError);
  });
});

describe("fetchGitHubStarHistory", () => {
  it("anchors daily increments to the current stargazer count", async () => {
    const fetchImplementation = routedFetch({
      [REPOSITORY_URL]: () => jsonResponse({ stargazers_count: 100 }),
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
      stars: 100,
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
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation).toHaveBeenCalledWith(
      REPOSITORY_URL,
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
      [REPOSITORY_URL]: () => jsonResponse({ stargazers_count: 1_000 }),
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
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("stops paging once the coverage window is satisfied", async () => {
    const fullPage = Array.from({ length: 30 }, (_, index) => ({
      week: WEEK_CURRENT - index * 7 * DAY_SECONDS,
      total: 0,
      days: [0, 0, 0, 0, 0, 0, 0],
    }));
    const fetchImplementation = routedFetch({
      [REPOSITORY_URL]: () => jsonResponse({ stargazers_count: 5 }),
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
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("drops empty future days from the current week", async () => {
    const fetchImplementation = routedFetch({
      [REPOSITORY_URL]: () => jsonResponse({ stargazers_count: 100 }),
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

    expect(history.days).toEqual([
      { start: "2026-08-30T00:00:00.000Z", end: "2026-08-31T00:00:00.000Z", stars_added: 1 },
      { start: "2026-08-31T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z", stars_added: 2 },
    ]);
  });

  it("rejects stars reported for days after the fetch time", async () => {
    const fetchImplementation = routedFetch({
      [REPOSITORY_URL]: () => jsonResponse({ stargazers_count: 100 }),
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

  it("rejects history that does not cover the fetch time", async () => {
    const fetchImplementation = routedFetch({
      [REPOSITORY_URL]: () => jsonResponse({ stargazers_count: 100 }),
      [HISTORY_URL]: () => historyResponse([sampleWeeks[1]]),
    });

    await expect(fetchGitHubStarHistory({
      fullName: "owner/repository",
      token: "token",
      coverFrom: "2026-08-24T00:00:00.000Z",
      fetchImplementation,
      now: () => NOW,
    })).rejects.toThrow(StarHistoryLagError);
  });

  it("reports GitHub failures with the rate limit reset time", async () => {
    const fetchImplementation = routedFetch({
      [REPOSITORY_URL]: () => jsonResponse({ message: "rate limited" }, {
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
    stars: 100,
    complete: true,
    days: [
      { start: "2026-09-02T00:00:00.000Z", end: "2026-09-03T00:00:00.000Z", stars_added: 10 },
      { start: "2026-09-03T00:00:00.000Z", end: "2026-09-04T00:00:00.000Z", stars_added: 20 },
      { start: "2026-09-04T00:00:00.000Z", end: "2026-09-05T00:00:00.000Z", stars_added: 30 },
      { start: "2026-09-05T00:00:00.000Z", end: "2026-09-06T00:00:00.000Z", stars_added: 4 },
    ],
  };
}

describe("buildDayEndPoints", () => {
  it("walks back from the anchor and skips the day in progress", () => {
    expect(buildDayEndPoints(sampleHistory())).toEqual([
      { captured_at: "2026-09-03T00:00:00.000Z", stars: 46 },
      { captured_at: "2026-09-04T00:00:00.000Z", stars: 66 },
      { captured_at: "2026-09-05T00:00:00.000Z", stars: 96 },
    ]);
  });

  it("rejects increments that exceed the anchored count", () => {
    const history = sampleHistory();
    history.stars = 3;
    expect(() => buildDayEndPoints(history)).toThrow("negative star count");
  });
});

describe("mergeStarSeries", () => {
  it("interleaves day-end points with observations inside the window", () => {
    const merged = mergeStarSeries(
      {
        full_name: "owner/repository",
        points: [
          { captured_at: "2026-09-03T12:00:00.000Z", stars: 55 },
          { captured_at: "2026-09-04T00:00:00.000Z", stars: 67 },
          { captured_at: "2026-09-04T12:00:00.000Z", stars: 80 },
          { captured_at: "2026-09-05T02:00:00.000Z", stars: 97 },
        ],
      },
      sampleHistory(),
      "2026-09-04T12:00:00.000Z",
      2,
    );

    expect(merged).toEqual({
      full_name: "owner/repository",
      points: [
        { captured_at: "2026-09-03T00:00:00.000Z", stars: 46 },
        { captured_at: "2026-09-03T12:00:00.000Z", stars: 55 },
        { captured_at: "2026-09-04T00:00:00.000Z", stars: 67 },
        { captured_at: "2026-09-04T12:00:00.000Z", stars: 80 },
      ],
    });
  });

  it("rejects mismatched repositories", () => {
    expect(() => mergeStarSeries(
      { full_name: "other/repository", points: [] },
      sampleHistory(),
      "2026-09-04T12:00:00.000Z",
    )).toThrow(TypeError);
  });
});

describe("StarHistoryStore", () => {
  it("caches fetched history on disk and reuses it while fresh", async () => {
    const cacheDirectory = join(mkdtempSync(join(tmpdir(), "star-history-")), "cache");
    const fetchImplementation = routedFetch({
      [REPOSITORY_URL]: () => jsonResponse({ stargazers_count: 100 }),
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
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(readdirSync(cacheDirectory)).toHaveLength(1);
  });

  it("refetches when the cache is stale and falls back to it when GitHub fails", async () => {
    const cacheDirectory = join(mkdtempSync(join(tmpdir(), "star-history-")), "cache");
    let current = NOW;
    let failing = false;
    const fetchImplementation = routedFetch({
      [REPOSITORY_URL]: () => failing
        ? jsonResponse({ message: "down" }, { status: 502 })
        : jsonResponse({ stargazers_count: 100 }),
      [HISTORY_URL]: () => historyResponse(sampleWeeks),
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
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("Serving stale star history"));
    errors.mockRestore();
  });

  it("surfaces GitHub failures when nothing is cached", async () => {
    const cacheDirectory = join(mkdtempSync(join(tmpdir(), "star-history-")), "cache");
    const store = new StarHistoryStore({
      cacheDirectory,
      token: "token",
      fetchImplementation: routedFetch({
        [REPOSITORY_URL]: () => jsonResponse({ message: "missing" }, { status: 404 }),
      }),
      now: () => NOW,
    });

    await expect(store.read("owner/repository", "2026-08-24T00:00:00.000Z"))
      .rejects.toThrow("status 404");
  });
});

describe("enrichStarSeries", () => {
  it("serves observed points only while GitHub has not opened the current week", async () => {
    const read = vi.fn(async () => {
      throw new StarHistoryLagError("owner/repository", NOW.toISOString());
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

    expect(response.series[0].points).toEqual([
      { captured_at: "2026-09-04T02:00:00.000Z", stars: 70 },
      { captured_at: "2026-09-05T02:00:00.000Z", stars: 97 },
    ]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("serving observed star series only"));
    errors.mockRestore();
  });

  it("propagates other GitHub failures", async () => {
    const read = vi.fn(async () => {
      throw new Error("GitHub repository owner/repository request failed with status 502");
    });
    await expect(enrichStarSeries(
      { schema_version: "1.0", series: [{ full_name: "owner/repository", points: [] }] },
      "2026-09-05T02:00:00.000Z",
      { read },
    )).rejects.toThrow("status 502");
  });

  it("extends each observed series with GitHub day-end points", async () => {
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
        points: [
          { captured_at: "2026-09-04T00:00:00.000Z", stars: 66 },
          { captured_at: "2026-09-05T00:00:00.000Z", stars: 96 },
          { captured_at: "2026-09-05T02:00:00.000Z", stars: 97 },
        ],
      }],
    });
    expect(read).toHaveBeenCalledWith("owner/repository", "2026-09-03T02:00:00.000Z");
  });
});
