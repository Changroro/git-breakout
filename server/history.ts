import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { HistoryResponse, RankingSnapshot } from "../src/lib/history.ts";
import { rankRepositories, type RepositoryCandidate, type RankedRepository } from "../src/lib/ranking.ts";

type SnapshotInput = {
  id: string;
  capturedAt: string;
  source: string;
  repositories: readonly RepositoryCandidate[];
};

type SnapshotRow = {
  id: string;
  captured_at: string;
  source: string;
};

type RepositoryRow = {
  payload_json: string;
};

type ObservationRow = {
  captured_at: string;
  payload_json: string;
};

export type StarObservation = {
  capturedAt: string;
  stars: number;
};

export type CollectorRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "failed";
  error_message: string | null;
};

export type StarHistoryCacheEntry = {
  fullName: string;
  status: "available" | "unavailable" | "failed";
  checkedAt: string;
  payload: unknown | null;
  errorMessage: string | null;
};

export class HistoryDatabase {
  readonly database: Database.Database;

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS ranking_snapshots (
        id TEXT PRIMARY KEY,
        captured_at TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'completed'),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ranking_snapshot_repositories (
        snapshot_id TEXT NOT NULL REFERENCES ranking_snapshots(id) ON DELETE RESTRICT,
        full_name TEXT NOT NULL,
        rank INTEGER NOT NULL CHECK (rank > 0),
        payload_json TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, full_name),
        UNIQUE (snapshot_id, rank)
      );

      CREATE TABLE IF NOT EXISTS collector_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        error_message TEXT,
        CHECK (
          (status = 'running' AND finished_at IS NULL AND error_message IS NULL) OR
          (status = 'completed' AND finished_at IS NOT NULL AND error_message IS NULL) OR
          (status = 'failed' AND finished_at IS NOT NULL AND error_message IS NOT NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS collector_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        interval_minutes INTEGER NOT NULL CHECK (interval_minutes > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collector_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS star_history_repositories (
        full_name TEXT PRIMARY KEY COLLATE NOCASE,
        status TEXT NOT NULL CHECK (status IN ('available', 'unavailable', 'failed')),
        checked_at TEXT NOT NULL,
        payload_json TEXT,
        error_message TEXT,
        CHECK (
          (status = 'available' AND payload_json IS NOT NULL AND error_message IS NULL) OR
          (status = 'unavailable' AND payload_json IS NULL AND error_message IS NULL) OR
          (status = 'failed' AND payload_json IS NULL AND error_message IS NOT NULL)
        )
      );

      INSERT OR IGNORE INTO collector_settings (id, interval_minutes, updated_at)
      VALUES (1, 120, '2026-08-25T00:00:00.000Z');
    `);
    this.migrateLegacyOpenGraphImages();
  }

  private migrateLegacyOpenGraphImages(): void {
    const rows = this.database.prepare(`
      SELECT snapshot_id, full_name, payload_json
      FROM ranking_snapshot_repositories
    `).all() as Array<{ snapshot_id: string; full_name: string; payload_json: string }>;
    const update = this.database.prepare(`
      UPDATE ranking_snapshot_repositories
      SET payload_json = ?
      WHERE snapshot_id = ? AND full_name = ?
    `);
    this.database.transaction(() => {
      rows.forEach((row) => {
        const repository = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (typeof repository.open_graph_image_url === "string") {
          return;
        }
        const segments = row.full_name.split("/");
        if (segments.length !== 2 || segments.some((segment) => segment === "")) {
          throw new TypeError(`Stored repository ${row.full_name} must use owner/name format`);
        }
        repository.open_graph_image_url = `https://opengraph.githubassets.com/legacy-v1/${segments.map(encodeURIComponent).join("/")}`;
        update.run(JSON.stringify(repository), row.snapshot_id, row.full_name);
      });
    })();
  }

  private insertCompletedSnapshot(input: SnapshotInput): void {
    const rankedRepositories = rankRepositories(input.repositories, input.capturedAt);
    const insertSnapshot = this.database.prepare(`
      INSERT INTO ranking_snapshots (id, captured_at, source, status, created_at)
      VALUES (?, ?, ?, 'completed', ?)
    `);
    const insertRepository = this.database.prepare(`
      INSERT INTO ranking_snapshot_repositories (snapshot_id, full_name, rank, payload_json)
      VALUES (?, ?, ?, ?)
    `);
    insertSnapshot.run(input.id, input.capturedAt, input.source, new Date().toISOString());
    rankedRepositories.forEach((repository) => {
      insertRepository.run(
        input.id,
        repository.full_name,
        repository.rank,
        JSON.stringify(repository),
      );
    });
  }

  private deleteSampleSnapshots(): void {
    this.database.prepare(`
      DELETE FROM ranking_snapshot_repositories
      WHERE snapshot_id IN (
        SELECT id FROM ranking_snapshots WHERE source = 'sample'
      )
    `).run();
    this.database.prepare("DELETE FROM ranking_snapshots WHERE source = 'sample'").run();
  }

  private validateSnapshot(input: SnapshotInput): void {
    if (input.id.trim() === "") {
      throw new TypeError("Snapshot id is required");
    }
    if (!Number.isFinite(Date.parse(input.capturedAt))) {
      throw new TypeError("Snapshot capturedAt must be a valid ISO-8601 timestamp");
    }
    if (input.source.trim() === "") {
      throw new TypeError("Snapshot source is required");
    }
    if (input.repositories.length === 0) {
      throw new RangeError("Snapshot must contain at least one repository");
    }
  }

  appendSnapshot(input: SnapshotInput): void {
    this.validateSnapshot(input);
    this.database.transaction(() => this.insertCompletedSnapshot(input))();
  }

  startCollectorRun(id: string, startedAt: string): void {
    if (id.trim() === "" || !Number.isFinite(Date.parse(startedAt))) {
      throw new TypeError("Collector run id and valid startedAt are required");
    }
    this.database.prepare(`
      INSERT INTO collector_runs (id, started_at, finished_at, status, error_message)
      VALUES (?, ?, NULL, 'running', NULL)
    `).run(id, startedAt);
  }

  completeCollectorRun(input: SnapshotInput): void {
    this.validateSnapshot(input);
    this.database.transaction(() => {
      this.deleteSampleSnapshots();
      this.insertCompletedSnapshot(input);
      const result = this.database.prepare(`
        UPDATE collector_runs
        SET finished_at = ?, status = 'completed', error_message = NULL
        WHERE id = ? AND status = 'running'
      `).run(input.capturedAt, input.id);
      if (result.changes !== 1) {
        throw new Error(`Running collector run ${input.id} does not exist`);
      }
    })();
  }

  failCollectorRun(id: string, finishedAt: string, errorMessage: string): void {
    if (!Number.isFinite(Date.parse(finishedAt)) || errorMessage.trim() === "") {
      throw new TypeError("Collector failure requires valid finishedAt and error message");
    }
    const result = this.database.prepare(`
      UPDATE collector_runs
      SET finished_at = ?, status = 'failed', error_message = ?
      WHERE id = ? AND status = 'running'
    `).run(finishedAt, errorMessage, id);
    if (result.changes !== 1) {
      throw new Error(`Running collector run ${id} does not exist`);
    }
  }

  readCollectorRuns(): CollectorRun[] {
    return this.database.prepare(`
      SELECT id, started_at, finished_at, status, error_message
      FROM collector_runs
      ORDER BY started_at ASC
    `).all() as CollectorRun[];
  }

  acquireCollectorLease(ownerId: string, acquiredAt: string, expiresAt: string): boolean {
    if (
      ownerId.trim() === "" ||
      !Number.isFinite(Date.parse(acquiredAt)) ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.parse(acquiredAt)
    ) {
      throw new TypeError("Collector lease requires owner and increasing timestamps");
    }
    return this.database.transaction(() => {
      this.database.prepare("DELETE FROM collector_lease WHERE expires_at <= ?").run(acquiredAt);
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO collector_lease (id, owner_id, acquired_at, expires_at)
        VALUES (1, ?, ?, ?)
      `).run(ownerId, acquiredAt, expiresAt);
      return result.changes === 1;
    })();
  }

  releaseCollectorLease(ownerId: string): void {
    const result = this.database.prepare(
      "DELETE FROM collector_lease WHERE id = 1 AND owner_id = ?",
    ).run(ownerId);
    if (result.changes !== 1) {
      throw new Error(`Collector lease for ${ownerId} does not exist`);
    }
  }

  readCollectionIntervalMinutes(): number {
    const row = this.database.prepare(
      "SELECT interval_minutes FROM collector_settings WHERE id = 1",
    ).get() as { interval_minutes: number } | undefined;
    if (row === undefined || !Number.isInteger(row.interval_minutes) || row.interval_minutes <= 0) {
      throw new Error("Collector interval setting is missing or invalid");
    }
    return row.interval_minutes;
  }

  readStarHistoryCache(fullName: string): StarHistoryCacheEntry | null {
    if (!/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
      throw new TypeError("Star History repository must use owner/name format");
    }
    const row = this.database.prepare(`
      SELECT full_name, status, checked_at, payload_json, error_message
      FROM star_history_repositories
      WHERE full_name = ? COLLATE NOCASE
    `).get(fullName) as {
      full_name: string;
      status: StarHistoryCacheEntry["status"];
      checked_at: string;
      payload_json: string | null;
      error_message: string | null;
    } | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      fullName: row.full_name,
      status: row.status,
      checkedAt: row.checked_at,
      payload: row.payload_json === null ? null : JSON.parse(row.payload_json),
      errorMessage: row.error_message,
    };
  }

  writeStarHistoryCache(entry: StarHistoryCacheEntry): void {
    if (!/^[^/\s]+\/[^/\s]+$/.test(entry.fullName)) {
      throw new TypeError("Star History repository must use owner/name format");
    }
    if (!Number.isFinite(Date.parse(entry.checkedAt))) {
      throw new TypeError("Star History checkedAt must be a valid ISO-8601 timestamp");
    }
    const validEntry =
      (entry.status === "available" && entry.payload !== null && entry.errorMessage === null) ||
      (entry.status === "unavailable" && entry.payload === null && entry.errorMessage === null) ||
      (entry.status === "failed" && entry.payload === null && entry.errorMessage !== null);
    if (!validEntry) {
      throw new TypeError("Star History cache entry does not match its status");
    }
    this.database.prepare(`
      INSERT INTO star_history_repositories (
        full_name, status, checked_at, payload_json, error_message
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(full_name) DO UPDATE SET
        status = excluded.status,
        checked_at = excluded.checked_at,
        payload_json = excluded.payload_json,
        error_message = excluded.error_message
    `).run(
      entry.fullName,
      entry.status,
      entry.checkedAt,
      entry.payload === null ? null : JSON.stringify(entry.payload),
      entry.errorMessage,
    );
  }

  readObservedRepositoryNames(): string[] {
    const rows = this.database.prepare(`
      SELECT repositories.full_name
      FROM ranking_snapshot_repositories AS repositories
      JOIN ranking_snapshots AS snapshots ON snapshots.id = repositories.snapshot_id
      WHERE snapshots.status = 'completed'
        AND snapshots.source IN ('github_official', 'github_combined')
      ORDER BY snapshots.captured_at DESC, repositories.rank ASC
    `).all() as Array<{ full_name: string }>;
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const key = row.full_name.toLowerCase();
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [row.full_name];
    });
  }

  readLatestCollectionCapturedAt(): string | null {
    const row = this.database.prepare(`
      SELECT captured_at
      FROM ranking_snapshots
      WHERE status = 'completed'
        AND source IN ('github_official', 'github_combined')
      ORDER BY captured_at DESC
      LIMIT 1
    `).get() as { captured_at: string } | undefined;
    if (row === undefined) {
      return null;
    }
    if (!Number.isFinite(Date.parse(row.captured_at))) {
      throw new TypeError("Latest collection timestamp is invalid");
    }
    return row.captured_at;
  }

  readStarObservations(fullName: string, before: string): StarObservation[] {
    if (
      fullName.trim() === "" ||
      !Number.isFinite(Date.parse(before))
    ) {
      throw new TypeError("Star history requires repository name and valid timestamp");
    }
    const rows = this.database.prepare(`
      SELECT snapshots.captured_at, repositories.payload_json
      FROM ranking_snapshot_repositories AS repositories
      JOIN ranking_snapshots AS snapshots ON snapshots.id = repositories.snapshot_id
      WHERE repositories.full_name = ? COLLATE NOCASE
        AND snapshots.status = 'completed'
        AND snapshots.source IN ('github_official', 'github_combined')
        AND snapshots.captured_at < ?
      ORDER BY snapshots.captured_at DESC
      LIMIT 20
    `).all(fullName, before) as ObservationRow[];
    return rows.map((row) => {
      const repository = JSON.parse(row.payload_json) as RankedRepository;
      const stars = repository.metrics.stars;
      if (!Number.isInteger(stars) || stars === null || stars < 0) {
        throw new TypeError(`Stored star observation for ${fullName} is invalid`);
      }
      return { capturedAt: row.captured_at, stars };
    });
  }

  readHistory(): HistoryResponse {
    const snapshotRows = this.database
      .prepare(`
        SELECT id, captured_at, source
        FROM ranking_snapshots
        WHERE status = 'completed'
        ORDER BY captured_at ASC
      `)
      .all() as SnapshotRow[];
    const repositoryQuery = this.database.prepare(`
      SELECT payload_json
      FROM ranking_snapshot_repositories
      WHERE snapshot_id = ?
      ORDER BY rank ASC
    `);
    const snapshots: RankingSnapshot[] = snapshotRows.map((snapshot) => {
      const repositories = (repositoryQuery.all(snapshot.id) as RepositoryRow[]).map(
        ({ payload_json }) => JSON.parse(payload_json) as RankedRepository,
      );
      if (repositories.length === 0) {
        throw new Error(`Completed snapshot ${snapshot.id} has no repositories`);
      }
      return { ...snapshot, repositories };
    });

    if (snapshots.length === 0) {
      throw new Error("No completed ranking snapshots are available");
    }

    return { schema_version: "1.0", snapshots };
  }

  close(): void {
    this.database.close();
  }
}
