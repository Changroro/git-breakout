import { parseRankingSnapshot } from "./history.js";
import type { RankedRepository } from "./ranking.js";

export type ArchiveRepository = RankedRepository & {
  last_snapshot_id: string;
  last_observed_at: string;
};

export type ArchivePageResponse = {
  schema_version: "1.0";
  latest_snapshot_id: string;
  latest_captured_at: string;
  archive_count: number;
  matching_count: number;
  page: number;
  page_size: number;
  repositories: ArchiveRepository[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = requireNonNegativeInteger(value, field);
  if (parsed === 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return parsed;
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return value;
}

export function parseArchivePageResponse(value: unknown): ArchivePageResponse {
  if (!isRecord(value) || value.schema_version !== "1.0" || !Array.isArray(value.repositories)) {
    throw new TypeError("Archive page response does not match schema version 1.0");
  }
  const rawRepositories = value.repositories;
  const latestSnapshotId = requireIdentifier(value.latest_snapshot_id, "latest_snapshot_id");
  const latestCapturedAt = requireTimestamp(value.latest_captured_at, "latest_captured_at");
  const archiveCount = requireNonNegativeInteger(value.archive_count, "archive_count");
  const matchingCount = requireNonNegativeInteger(value.matching_count, "matching_count");
  const page = requirePositiveInteger(value.page, "page");
  const pageSize = requirePositiveInteger(value.page_size, "page_size");
  if (matchingCount > archiveCount) {
    throw new RangeError("matching_count cannot exceed archive_count");
  }
  if (rawRepositories.length > pageSize || rawRepositories.length > matchingCount) {
    throw new RangeError("Archive repositories exceed the declared page bounds");
  }
  const parsedRepositories = parseRankingSnapshot({
    id: latestSnapshotId,
    captured_at: latestCapturedAt,
    source: "archive",
    repositories: rawRepositories,
  }).repositories;
  const seen = new Set<string>();
  const repositories = parsedRepositories.map((repository, index) => {
    const candidate = rawRepositories[index];
    if (!isRecord(candidate)) {
      throw new TypeError(`repositories[${index}] must be an object`);
    }
    const key = repository.full_name.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      throw new TypeError("Archive repositories must be unique");
    }
    seen.add(key);
    const lastObservedAt = requireTimestamp(
      candidate.last_observed_at,
      `repositories[${index}].last_observed_at`,
    );
    if (Date.parse(lastObservedAt) > Date.parse(latestCapturedAt)) {
      throw new RangeError(`repositories[${index}].last_observed_at cannot be in the future`);
    }
    return {
      ...repository,
      last_snapshot_id: requireIdentifier(
        candidate.last_snapshot_id,
        `repositories[${index}].last_snapshot_id`,
      ),
      last_observed_at: lastObservedAt,
    };
  });
  return {
    schema_version: "1.0",
    latest_snapshot_id: latestSnapshotId,
    latest_captured_at: latestCapturedAt,
    archive_count: archiveCount,
    matching_count: matchingCount,
    page,
    page_size: pageSize,
    repositories,
  };
}
