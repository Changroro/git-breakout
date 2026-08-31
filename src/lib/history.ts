import type { RankedRepository } from "./ranking.ts";

export type RankingSnapshot = {
  id: string;
  captured_at: string;
  source: string;
  repositories: RankedRepository[];
};

export type HistoryResponse = {
  schema_version: "1.0";
  snapshots: RankingSnapshot[];
};

export type RankingSnapshotMetadata = Omit<RankingSnapshot, "repositories"> & {
  repository_count: number;
};

export type TimelineResponse = {
  schema_version: "1.0";
  snapshots: RankingSnapshotMetadata[];
};

export type RepositoryFacet = {
  value: string;
  label: string;
  count: number;
};

export type RankingPageResponse = Omit<RankingSnapshot, "repositories"> & {
  schema_version: "1.0";
  repository_count: number;
  matching_count: number;
  page: number;
  page_size: number;
  intelligence_available: boolean;
  languages: RepositoryFacet[];
  topics: RepositoryFacet[];
  repositories: RankedRepository[];
};

export type RepositorySearchResponse = {
  schema_version: "1.0";
  total_count: number;
  repositories: RankedRepository[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseHistoryResponse(value: unknown): HistoryResponse {
  if (!isRecord(value) || value.schema_version !== "1.0" || !Array.isArray(value.snapshots)) {
    throw new TypeError("History response does not match schema version 1.0");
  }

  value.snapshots.forEach((snapshot, index) => {
    if (
      !isRecord(snapshot) ||
      typeof snapshot.id !== "string" ||
      typeof snapshot.captured_at !== "string" ||
      !Number.isFinite(Date.parse(snapshot.captured_at)) ||
      typeof snapshot.source !== "string" ||
      !Array.isArray(snapshot.repositories)
    ) {
      throw new TypeError(`History snapshot ${index} is invalid`);
    }
    snapshot.repositories.forEach((repository, repositoryIndex) => {
      if (
        !isRecord(repository) ||
        typeof repository.open_graph_image_url !== "string" ||
        URL.parse(repository.open_graph_image_url)?.protocol !== "https:"
      ) {
        throw new TypeError(
          `History snapshot ${index} repository ${repositoryIndex} has an invalid Open Graph image`,
        );
      }
    });
  });

  return value as HistoryResponse;
}

export function parseTimelineResponse(value: unknown): TimelineResponse {
  if (!isRecord(value) || value.schema_version !== "1.0" || !Array.isArray(value.snapshots)) {
    throw new TypeError("Timeline response does not match schema version 1.0");
  }
  value.snapshots.forEach((snapshot, index) => {
    if (
      !isRecord(snapshot) ||
      typeof snapshot.id !== "string" ||
      typeof snapshot.captured_at !== "string" ||
      !Number.isFinite(Date.parse(snapshot.captured_at)) ||
      typeof snapshot.source !== "string" ||
      !Number.isInteger(snapshot.repository_count) ||
      (snapshot.repository_count as number) <= 0
    ) {
      throw new TypeError(`Timeline snapshot ${index} is invalid`);
    }
  });
  if (value.snapshots.length === 0) {
    throw new RangeError("At least one completed snapshot is required");
  }
  return value as TimelineResponse;
}

export function parseRankingSnapshot(value: unknown): RankingSnapshot {
  return parseHistoryResponse({ schema_version: "1.0", snapshots: [value] }).snapshots[0];
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

function parseFacets(value: unknown, field: string): RepositoryFacet[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new TypeError(`${field}[${index}] must be an object`);
    }
    if (
      typeof candidate.value !== "string"
      || candidate.value.trim() === ""
      || typeof candidate.label !== "string"
      || candidate.label.trim() === ""
    ) {
      throw new TypeError(`${field}[${index}] must contain a value and label`);
    }
    const normalized = candidate.value.toLocaleLowerCase("en-US");
    if (seen.has(normalized)) {
      throw new TypeError(`${field} must not contain duplicate values`);
    }
    seen.add(normalized);
    return {
      value: candidate.value,
      label: candidate.label,
      count: requirePositiveInteger(candidate.count, `${field}[${index}].count`),
    };
  });
}

function parseRepositoryPayloads(value: unknown, field: string): RankedRepository[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  return parseRankingSnapshot({
    id: "validation",
    captured_at: "2000-01-01T00:00:00.000Z",
    source: "validation",
    repositories: value,
  }).repositories;
}

export function parseRankingPageResponse(value: unknown): RankingPageResponse {
  if (!isRecord(value) || value.schema_version !== "1.0") {
    throw new TypeError("Ranking page response does not match schema version 1.0");
  }
  const metadata = parseRankingSnapshot({
    id: value.id,
    captured_at: value.captured_at,
    source: value.source,
    repositories: value.repositories,
  });
  const repositoryCount = requirePositiveInteger(value.repository_count, "repository_count");
  const matchingCount = requireNonNegativeInteger(value.matching_count, "matching_count");
  const page = requirePositiveInteger(value.page, "page");
  const pageSize = requirePositiveInteger(value.page_size, "page_size");
  if (metadata.repositories.length > pageSize) {
    throw new RangeError("Ranking page repositories exceed page_size");
  }
  if (matchingCount > repositoryCount) {
    throw new RangeError("matching_count cannot exceed repository_count");
  }
  if (typeof value.intelligence_available !== "boolean") {
    throw new TypeError("intelligence_available must be boolean");
  }
  return {
    schema_version: "1.0",
    ...metadata,
    repository_count: repositoryCount,
    matching_count: matchingCount,
    page,
    page_size: pageSize,
    intelligence_available: value.intelligence_available,
    languages: parseFacets(value.languages, "languages"),
    topics: parseFacets(value.topics, "topics"),
  };
}

export function parseRepositorySearchResponse(value: unknown): RepositorySearchResponse {
  if (!isRecord(value) || value.schema_version !== "1.0") {
    throw new TypeError("Repository search response does not match schema version 1.0");
  }
  const repositories = parseRepositoryPayloads(value.repositories, "repositories");
  const totalCount = requireNonNegativeInteger(value.total_count, "total_count");
  if (repositories.length > totalCount) {
    throw new RangeError("Search result count cannot exceed total_count");
  }
  return { schema_version: "1.0", total_count: totalCount, repositories };
}

export function resolveSnapshotId(
  requestedId: string | null,
  snapshots: readonly { id: string }[],
): string {
  if (snapshots.length === 0) {
    throw new RangeError("At least one completed snapshot is required");
  }

  if (requestedId !== null && snapshots.some((snapshot) => snapshot.id === requestedId)) {
    return requestedId;
  }

  return snapshots[snapshots.length - 1].id;
}
