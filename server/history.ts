import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { HistoryResponse, RankingSnapshot } from "../src/lib/history.ts";
import { rankRepositories, type RepositoryCandidate, type RankedRepository } from "../src/lib/ranking.ts";
import {
  parseStarSeriesResponse,
  type StarSeriesResponse,
} from "../src/lib/star-series.ts";
import {
  selectRetainedRepositoryNames,
  type RepositoryRetentionCandidate,
  type RetentionPolicy,
} from "./retention.ts";

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

type RetentionRow = ObservationRow & {
  full_name: string;
  rank: number;
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
        retention_grace_days INTEGER CHECK (retention_grace_days > 0),
        retention_growth_days INTEGER CHECK (retention_growth_days > 0),
        retention_push_days INTEGER CHECK (retention_push_days > 0),
        retention_repository_limit INTEGER CHECK (retention_repository_limit > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS collector_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    this.migrateCollectorRetentionSettings();
    this.database.prepare(`
      INSERT OR IGNORE INTO collector_settings (
        id,
        interval_minutes,
        retention_grace_days,
        retention_growth_days,
        retention_push_days,
        retention_repository_limit,
        updated_at
      )
      VALUES (1, 120, 14, 7, 30, 1000, '2026-08-25T00:00:00.000Z')
    `).run();
    this.migrateLegacyOpenGraphImages();
  }

  private migrateCollectorRetentionSettings(): void {
    const columns = new Set((this.database.prepare("PRAGMA table_info(collector_settings)").all() as Array<{
      name: string;
    }>).map(({ name }) => name));
    const retentionColumns = [
      ["retention_grace_days", 14],
      ["retention_growth_days", 7],
      ["retention_push_days", 30],
      ["retention_repository_limit", 1_000],
    ] as const;
    retentionColumns.forEach(([name]) => {
      if (!columns.has(name)) {
        this.database.exec(`ALTER TABLE collector_settings ADD COLUMN ${name} INTEGER`);
      }
    });
    this.database.prepare(`
      UPDATE collector_settings
      SET
        retention_grace_days = COALESCE(retention_grace_days, 14),
        retention_growth_days = COALESCE(retention_growth_days, 7),
        retention_push_days = COALESCE(retention_push_days, 30),
        retention_repository_limit = COALESCE(retention_repository_limit, 1000)
    `).run();
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

  readRetentionPolicy(): RetentionPolicy {
    const row = this.database.prepare(`
      SELECT
        retention_grace_days,
        retention_growth_days,
        retention_push_days,
        retention_repository_limit
      FROM collector_settings
      WHERE id = 1
    `).get() as {
      retention_grace_days: number;
      retention_growth_days: number;
      retention_push_days: number;
      retention_repository_limit: number;
    } | undefined;
    if (
      row === undefined
      || !Number.isInteger(row.retention_grace_days)
      || row.retention_grace_days <= 0
      || !Number.isInteger(row.retention_growth_days)
      || row.retention_growth_days <= 0
      || !Number.isInteger(row.retention_push_days)
      || row.retention_push_days <= 0
      || !Number.isInteger(row.retention_repository_limit)
      || row.retention_repository_limit <= 0
    ) {
      throw new Error("Collector retention policy is missing or invalid");
    }
    return {
      graceDays: row.retention_grace_days,
      growthDays: row.retention_growth_days,
      pushDays: row.retention_push_days,
      repositoryLimit: row.retention_repository_limit,
    };
  }

  readStarSeries(fullNames: readonly string[], before: string): StarSeriesResponse {
    if (
      fullNames.length < 1
      || fullNames.length > 10
      || !Number.isFinite(Date.parse(before))
      || fullNames.some((fullName) => !/^[^/\s]+\/[^/\s]+$/.test(fullName))
    ) {
      throw new TypeError("Star series requires 1-10 repositories and a valid timestamp");
    }
    const uniqueNames = new Set(fullNames.map((fullName) => fullName.toLowerCase()));
    if (uniqueNames.size !== fullNames.length) {
      throw new TypeError("Star series repository names must be unique");
    }
    const placeholders = fullNames.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT repositories.full_name, snapshots.captured_at, repositories.payload_json
      FROM ranking_snapshot_repositories AS repositories
      JOIN ranking_snapshots AS snapshots ON snapshots.id = repositories.snapshot_id
      WHERE repositories.full_name COLLATE NOCASE IN (${placeholders})
        AND snapshots.captured_at <= ?
      ORDER BY snapshots.captured_at ASC
    `).all(...fullNames, before) as Array<{
      full_name: string;
      captured_at: string;
      payload_json: string;
    }>;
    const points = new Map(fullNames.map((fullName) => [fullName.toLowerCase(), [] as Array<{
      captured_at: string;
      stars: number;
    }>]));
    rows.forEach((row) => {
      const repository = JSON.parse(row.payload_json) as RankedRepository;
      const stars = repository.metrics.stars;
      if (!Number.isInteger(stars) || stars === null || stars < 0) {
        throw new TypeError(`Stored star observation for ${row.full_name} is invalid`);
      }
      const series = points.get(row.full_name.toLowerCase());
      if (series === undefined) {
        throw new Error(`Unexpected star series repository ${row.full_name}`);
      }
      series.push({ captured_at: row.captured_at, stars });
    });
    return parseStarSeriesResponse({
      schema_version: "1.0",
      series: fullNames.map((fullName) => ({
        full_name: fullName,
        points: points.get(fullName.toLowerCase()),
      })),
    });
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

  readRetainedRepositoryNames(): string[] {
    const referenceAt = this.readLatestCollectionCapturedAt();
    if (referenceAt === null) {
      return [];
    }
    const policy = this.readRetentionPolicy();
    const rows = this.database.prepare(`
      SELECT
        repositories.full_name,
        repositories.rank,
        snapshots.captured_at,
        repositories.payload_json
      FROM ranking_snapshot_repositories AS repositories
      JOIN ranking_snapshots AS snapshots ON snapshots.id = repositories.snapshot_id
      WHERE snapshots.status = 'completed'
        AND snapshots.source IN ('github_official', 'github_combined')
      ORDER BY repositories.full_name COLLATE NOCASE, snapshots.captured_at DESC
    `).all() as RetentionRow[];
    const rowsByName = new Map<string, RetentionRow[]>();
    rows.forEach((row) => {
      const key = row.full_name.toLowerCase();
      const repositoryRows = rowsByName.get(key);
      if (repositoryRows === undefined) {
        rowsByName.set(key, [row]);
        return;
      }
      repositoryRows.push(row);
    });
    const comparisonCutoff = Date.parse(referenceAt) - policy.growthDays * 86_400_000;
    const candidates: RepositoryRetentionCandidate[] = [...rowsByName.values()].map(
      (repositoryRows) => {
        const latest = repositoryRows[0];
        const first = repositoryRows.at(-1);
        if (latest === undefined || first === undefined) {
          throw new Error("Collector retention history is empty");
        }
        const latestRepository = JSON.parse(latest.payload_json) as RankedRepository;
        const latestStars = latestRepository.metrics.stars;
        if (!Number.isInteger(latestStars) || latestStars === null || latestStars < 0) {
          throw new TypeError(`Stored retention stars for ${latest.full_name} are invalid`);
        }
        const comparison = repositoryRows.find(
          (row) => Date.parse(row.captured_at) <= comparisonCutoff,
        );
        let growthComparisonStars: number | null = null;
        if (comparison !== undefined) {
          const comparisonRepository = JSON.parse(comparison.payload_json) as RankedRepository;
          const comparisonStars = comparisonRepository.metrics.stars;
          if (!Number.isInteger(comparisonStars) || comparisonStars === null || comparisonStars < 0) {
            throw new TypeError(`Stored retention comparison for ${latest.full_name} is invalid`);
          }
          growthComparisonStars = comparisonStars;
        }
        return {
          fullName: latest.full_name,
          firstSeenAt: first.captured_at,
          latestCapturedAt: latest.captured_at,
          latestPushedAt: latestRepository.pushed_at,
          latestRank: latest.rank,
          latestStars,
          growthComparisonStars,
        };
      },
    );
    return selectRetainedRepositoryNames(candidates, referenceAt, policy);
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
      throw new TypeError("Star observations require repository name and valid timestamp");
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
