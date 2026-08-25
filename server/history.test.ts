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
});
