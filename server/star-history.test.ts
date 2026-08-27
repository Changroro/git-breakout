import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryDatabase } from "./history.ts";
import { loadStarHistoryRepository } from "./star-history.ts";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true }));
});

function createDatabase(): HistoryDatabase {
  const directory = mkdtempSync(join(tmpdir(), "star-history-cache-"));
  directories.push(directory);
  return new HistoryDatabase(join(directory, "history.sqlite"));
}

function apiPayload() {
  return {
    repo: {
      name: "apache/maka",
      owner: "apache",
      owner_type: "Organization",
      stars_total: 3082,
      description: "Local-first AI agent workspace",
      language: "TypeScript",
      topics: ["ai", "local-first"],
      license: "Apache-2.0",
      homepage: null,
      forks_count: 313,
      contributors_count: 83,
      open_issues_count: 271,
      created_at: "2026-05-27T15:46:05.000Z",
      archived: false,
      size: 81362,
      weekly_percentiles: {
        stars: 4,
        new_stars: 86,
        pushes: 99,
        contributors: 57,
        issues_closed: 97,
        forks: 10,
      },
      weekly_activity: { new_stars: 1, pushes: 28, issues_closed: 1 },
      milestones: [],
    },
  };
}

describe("loadStarHistoryRepository", () => {
  it("persists a valid response and reuses it for two hours", async () => {
    const database = createDatabase();
    const fetchMock = vi.fn(async () => Response.json(apiPayload()));
    const now = () => new Date("2026-08-26T03:00:00.000Z");

    const first = await loadStarHistoryRepository({
      repositoryName: "apache/maka",
      database,
      fetchImplementation: fetchMock as typeof fetch,
      now,
    });
    const second = await loadStarHistoryRepository({
      repositoryName: "apache/maka",
      database,
      fetchImplementation: fetchMock as typeof fetch,
      now: () => new Date("2026-08-26T04:59:59.000Z"),
    });

    expect(first).toEqual(second);
    expect(first.status).toBe("available");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(database.readStarHistoryCache("apache/maka")?.status).toBe("available");
    database.close();
  });

  it("refreshes a cached response after two hours", async () => {
    const database = createDatabase();
    const fetchMock = vi.fn(async () => Response.json(apiPayload()));
    await loadStarHistoryRepository({
      repositoryName: "apache/maka",
      database,
      fetchImplementation: fetchMock as typeof fetch,
      now: () => new Date("2026-08-26T03:00:00.000Z"),
    });
    await loadStarHistoryRepository({
      repositoryName: "apache/maka",
      database,
      fetchImplementation: fetchMock as typeof fetch,
      now: () => new Date("2026-08-26T05:00:00.000Z"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    database.close();
  });

  it("stores and reuses an unavailable result", async () => {
    const database = createDatabase();
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    const first = await loadStarHistoryRepository({
      repositoryName: "apache/missing",
      database,
      fetchImplementation: fetchMock as typeof fetch,
      now: () => new Date("2026-08-26T03:00:00.000Z"),
    });
    const second = await loadStarHistoryRepository({
      repositoryName: "apache/missing",
      database,
      fetchImplementation: fetchMock as typeof fetch,
      now: () => new Date("2026-08-26T04:00:00.000Z"),
    });

    expect(first).toEqual(second);
    expect(first.status).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(database.readStarHistoryCache("apache/missing")?.status).toBe("unavailable");
    database.close();
  });

  it("records malformed responses as failures", async () => {
    const database = createDatabase();
    const malformed = apiPayload();
    malformed.repo.weekly_percentiles.pushes = 101;

    await expect(loadStarHistoryRepository({
      repositoryName: "apache/maka",
      database,
      fetchImplementation: vi.fn(async () => Response.json(malformed)) as typeof fetch,
      now: () => new Date("2026-08-26T03:00:00.000Z"),
    })).rejects.toThrow("repo.weekly_percentiles.pushes");
    expect(database.readStarHistoryCache("apache/maka")).toMatchObject({
      status: "failed",
      payload: null,
    });
    database.close();
  });
});
