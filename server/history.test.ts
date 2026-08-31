import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sampleRepositories } from "../src/data/repositories.ts";
import { HistoryDatabase } from "./history.ts";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true }));
});

function createDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "ranking-history-"));
  directories.push(directory);
  return new HistoryDatabase(join(directory, "history.sqlite"));
}

describe("HistoryDatabase", () => {
  it("starts without synthetic snapshots", () => {
    const database = createDatabase();

    expect(() => database.readHistory()).toThrow("No completed ranking snapshots are available");
    database.close();
  });

  it("persists a completed snapshot with ranked repositories", () => {
    const database = createDatabase();
    database.appendSnapshot({
      id: "run-1",
      capturedAt: "2026-08-25T00:00:00.000Z",
      source: "test",
      repositories: sampleRepositories,
    });

    const history = database.readHistory();
    expect(history.snapshots).toHaveLength(1);
    expect(history.snapshots[0].repositories).toHaveLength(30);
    expect(history.snapshots[0].repositories[0].rank).toBe(1);
    database.close();
  });

  it("marks stored repository payloads without provenance as legacy-compatible", () => {
    const database = createDatabase();
    const databasePath = database.database.name;
    database.database.prepare(`
      INSERT INTO ranking_snapshots (id, captured_at, source, status, created_at)
      VALUES (?, ?, ?, 'completed', ?)
    `).run("legacy-run", "2026-08-24T00:00:00.000Z", "legacy", "2026-08-24T00:00:00.000Z");
    database.database.prepare(`
      INSERT INTO ranking_snapshot_repositories (snapshot_id, full_name, rank, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(
      "legacy-run",
      "owner/repository",
      1,
      JSON.stringify({ full_name: "owner/repository", rank: 1 }),
    );
    database.close();

    const reopened = new HistoryDatabase(databasePath);
    const repository = reopened.readHistory().snapshots[0].repositories[0];
    expect(repository.observation_sources).toBeNull();
    expect(repository.open_graph_image_url).toBe(
      "https://opengraph.githubassets.com/legacy-v1/owner/repository",
    );
    reopened.close();
  });

  it("refuses to overwrite an existing run", () => {
    const database = createDatabase();
    const snapshot = {
      id: "run-1",
      capturedAt: "2026-08-25T00:00:00.000Z",
      source: "test",
      repositories: sampleRepositories,
    };
    database.appendSnapshot(snapshot);

    expect(() => database.appendSnapshot(snapshot)).toThrow();
    expect(database.readHistory().snapshots).toHaveLength(1);
    database.close();
  });

  it("completes a collector run and snapshot in one transaction", () => {
    const database = createDatabase();
    database.startCollectorRun("run-1", "2026-08-25T00:00:00.000Z");
    database.completeCollectorRun({
      id: "run-1",
      capturedAt: "2026-08-25T00:02:00.000Z",
      source: "github_official",
      repositories: sampleRepositories,
    });

    expect(database.readCollectorRuns()).toEqual([{
      id: "run-1",
      started_at: "2026-08-25T00:00:00.000Z",
      finished_at: "2026-08-25T00:02:00.000Z",
      status: "completed",
      error_message: null,
    }]);
    expect(database.readHistory().snapshots[0].id).toBe("run-1");
    expect(database.readLatestCompletedCollectorStartedAt()).toBe("2026-08-25T00:00:00.000Z");
    database.close();
  });

  it("does not use failed collector starts for the next scheduled run", () => {
    const database = createDatabase();
    database.startCollectorRun("run-1", "2026-08-25T00:00:00.000Z");
    database.failCollectorRun(
      "run-1",
      "2026-08-25T00:01:00.000Z",
      "temporary GitHub failure",
    );

    expect(database.readLatestCompletedCollectorStartedAt()).toBeNull();
    database.close();
  });

  it("removes seeded samples when the first live collection completes", () => {
    const database = createDatabase();
    database.appendSnapshot({
      id: "sample-run",
      capturedAt: "2026-08-24T00:00:00.000Z",
      source: "sample",
      repositories: sampleRepositories,
    });
    database.startCollectorRun("run-1", "2026-08-25T00:00:00.000Z");
    database.completeCollectorRun({
      id: "run-1",
      capturedAt: "2026-08-25T00:02:00.000Z",
      source: "github_combined",
      repositories: sampleRepositories,
    });

    expect(database.readHistory().snapshots.map((snapshot) => snapshot.source)).toEqual([
      "github_combined",
    ]);
    database.close();
  });

  it("records failed collector runs without exposing a snapshot", () => {
    const database = createDatabase();
    database.startCollectorRun("run-1", "2026-08-25T00:00:00.000Z");
    database.failCollectorRun(
      "run-1",
      "2026-08-25T00:01:00.000Z",
      "GitHub Trending daily returned no repository rows",
    );

    expect(database.readCollectorRuns()[0]).toMatchObject({
      id: "run-1",
      status: "failed",
      error_message: "GitHub Trending daily returned no repository rows",
    });
    expect(() => database.readHistory()).toThrow("No completed ranking snapshots");
    database.close();
  });

  it("stores a two-hour interval and prevents overlapping collector leases", () => {
    const database = createDatabase();
    expect(database.readCollectionIntervalMinutes()).toBe(120);
    expect(database.readRetentionPolicy()).toEqual({
      graceDays: 14,
      growthDays: 7,
      pushDays: 30,
      repositoryLimit: 1_000,
    });
    expect(database.acquireCollectorLease(
      "owner-1",
      "2026-08-25T00:00:00.000Z",
      "2026-08-25T00:30:00.000Z",
    )).toBe(true);
    expect(database.acquireCollectorLease(
      "owner-2",
      "2026-08-25T00:01:00.000Z",
      "2026-08-25T00:31:00.000Z",
    )).toBe(false);
    database.releaseCollectorLease("owner-1");
    database.close();
  });

  it("retains growing repositories and cuts off inactive repositories after fourteen days", () => {
    const database = createDatabase();
    const inactive = {
      ...sampleRepositories[0],
      pushed_at: "2026-07-01T00:00:00.000Z",
    };
    const growing = {
      ...sampleRepositories[1],
      pushed_at: "2026-07-01T00:00:00.000Z",
    };
    database.appendSnapshot({
      id: "run-1",
      capturedAt: "2026-08-01T00:00:00.000Z",
      source: "github_combined",
      repositories: [inactive, growing],
    });
    database.appendSnapshot({
      id: "run-2",
      capturedAt: "2026-08-27T00:00:00.000Z",
      source: "github_combined",
      repositories: [
        inactive,
        {
          ...growing,
          metrics: {
            ...growing.metrics,
            stars: growing.metrics.stars === null ? null : growing.metrics.stars + 1,
          },
        },
      ],
    });

    expect(database.readRetainedRepositoryNames()).toEqual([growing.full_name]);
    expect(database.readHistory().snapshots[0].repositories).toHaveLength(2);
    database.close();
  });

  it("keeps the observed repository pool and reads growth across snapshot sources", () => {
    const database = createDatabase();
    database.appendSnapshot({
      id: "sample-run",
      capturedAt: "2026-08-24T00:00:00.000Z",
      source: "sample",
      repositories: sampleRepositories,
    });
    database.appendSnapshot({
      id: "run-1",
      capturedAt: "2026-08-25T00:00:00.000Z",
      source: "github_official",
      repositories: sampleRepositories,
    });

    expect(database.readObservedRepositoryNames()).toHaveLength(30);
    expect(database.readObservedRepositoryNames()).toContain(sampleRepositories[0].full_name);
    expect(database.readLatestCollectionCapturedAt()).toBe("2026-08-25T00:00:00.000Z");
    expect(database.readStarObservations(
      sampleRepositories[0].full_name,
      "2026-08-25T02:00:00.000Z",
    )).toEqual([{
      capturedAt: "2026-08-25T00:00:00.000Z",
      stars: sampleRepositories[0].metrics.stars,
    }]);
    database.close();
  });

  it("reads repository star series through a selected capture time", () => {
    const database = createDatabase();
    const fullName = sampleRepositories[0].full_name;
    database.appendSnapshot({
      id: "run-1",
      capturedAt: "2026-08-25T00:00:00.000Z",
      source: "github_combined",
      repositories: sampleRepositories,
    });
    database.appendSnapshot({
      id: "run-2",
      capturedAt: "2026-08-25T02:00:00.000Z",
      source: "github_combined",
      repositories: sampleRepositories.map((repository) => repository.full_name === fullName
        ? {
          ...repository,
          metrics: {
            ...repository.metrics,
            stars: repository.metrics.stars === null ? null : repository.metrics.stars + 5,
          },
        }
        : repository),
    });

    expect(database.readStarSeries([fullName], "2026-08-25T02:00:00.000Z")).toEqual({
      schema_version: "1.0",
      series: [{
        full_name: fullName,
        points: [
          {
            captured_at: "2026-08-25T00:00:00.000Z",
            stars: sampleRepositories[0].metrics.stars,
          },
          {
            captured_at: "2026-08-25T02:00:00.000Z",
            stars: sampleRepositories[0].metrics.stars === null
              ? null
              : sampleRepositories[0].metrics.stars + 5,
          },
        ],
      }],
    });
    database.close();
  });
});
