import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HistoryDatabase } from "./history.ts";
import { sampleRepositories } from "../src/data/repositories.ts";

it("reads timeline metadata and one snapshot without decoding unrelated history", () => {
  const directory = mkdtempSync(join(tmpdir(), "history-read-cost-"));
  const database = new HistoryDatabase(join(directory, "test.sqlite"));
  try {
    database.appendSnapshot({ id: "old", capturedAt: "2026-08-25T00:00:00.000Z", source: "test", repositories: [sampleRepositories[0]] });
    database.appendSnapshot({ id: "latest", capturedAt: "2026-08-26T00:00:00.000Z", source: "test", repositories: [sampleRepositories[1]] });
    database.database.prepare("UPDATE ranking_snapshot_repositories SET payload_json = 'broken' WHERE snapshot_id = 'old'").run();
    expect(database.readTimeline().snapshots).toHaveLength(2);
    expect(database.readSnapshot("latest")?.repositories[0].full_name).toBe(sampleRepositories[1].full_name);
    expect(database.readSnapshot("missing")).toBeUndefined();
    expect(() => database.readSnapshot("old")).toThrow();
  } finally { database.close(); rmSync(directory, { recursive: true }); }
});

it("bounds observed chart payloads to the documented ninety-day window", () => {
  const directory = mkdtempSync(join(tmpdir(), "history-window-"));
  const database = new HistoryDatabase(join(directory, "test.sqlite"));
  try {
    for (const [id, capturedAt] of [["old", "2026-04-01T00:00:00.000Z"], ["new", "2026-09-01T00:00:00.000Z"]]) {
      database.appendSnapshot({ id, capturedAt, source: "test", repositories: [sampleRepositories[0]] });
    }
    const result = database.readStarSeries([sampleRepositories[0].full_name], "2026-09-01T00:00:00.000Z");
    expect(result.series[0].points).toHaveLength(1);
    expect(result.series[0].points[0].captured_at).toBe("2026-09-01T00:00:00.000Z");
  } finally { database.close(); rmSync(directory, { recursive: true }); }
});
