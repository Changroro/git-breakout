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

export function resolveSnapshotId(
  requestedId: string | null,
  snapshots: readonly RankingSnapshot[],
): string {
  if (snapshots.length === 0) {
    throw new RangeError("At least one completed snapshot is required");
  }

  if (requestedId !== null && snapshots.some((snapshot) => snapshot.id === requestedId)) {
    return requestedId;
  }

  return snapshots[snapshots.length - 1].id;
}
