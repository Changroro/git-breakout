import type { StarHistoryLookup } from "../src/lib/star-history.ts";
import { parseStarHistoryRepository } from "../src/lib/star-history.ts";
import { HistoryDatabase, type StarHistoryCacheEntry } from "./history.ts";

const STAR_HISTORY_REPOSITORY_API = "https://api.star-history.com/repo";
const REQUEST_TIMEOUT_MS = 10_000;

function validateRepositoryName(repositoryName: string): string {
  const trimmed = repositoryName.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    throw new TypeError("Star History repository must use owner/name format");
  }
  return trimmed;
}

function isFresh(entry: StarHistoryCacheEntry, now: Date, intervalMinutes: number): boolean {
  const checkedAt = Date.parse(entry.checkedAt);
  if (!Number.isFinite(checkedAt)) {
    throw new TypeError(`Stored Star History timestamp for ${entry.fullName} is invalid`);
  }
  return now.getTime() - checkedAt < intervalMinutes * 60_000;
}

function readCachedLookup(entry: StarHistoryCacheEntry): StarHistoryLookup {
  if (entry.status === "failed") {
    throw new Error(entry.errorMessage ?? `Stored Star History failure for ${entry.fullName} is invalid`);
  }
  if (entry.status === "unavailable") {
    return { status: "unavailable", checked_at: entry.checkedAt, repo: null };
  }
  return {
    status: "available",
    checked_at: entry.checkedAt,
    repo: parseStarHistoryRepository(entry.payload),
  };
}

function repositoryApiUrl(repositoryName: string): string {
  return `${STAR_HISTORY_REPOSITORY_API}/${repositoryName.split("/").map(encodeURIComponent).join("/")}`;
}

export async function loadStarHistoryRepository({
  repositoryName,
  database,
  fetchImplementation = fetch,
  now = () => new Date(),
}: {
  repositoryName: string;
  database: HistoryDatabase;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
}): Promise<StarHistoryLookup> {
  const fullName = validateRepositoryName(repositoryName);
  const requestedAt = now();
  const intervalMinutes = database.readCollectionIntervalMinutes();
  const cached = database.readStarHistoryCache(fullName);
  if (cached !== null && isFresh(cached, requestedAt, intervalMinutes)) {
    return readCachedLookup(cached);
  }

  let response: Response;
  try {
    response = await fetchImplementation(repositoryApiUrl(fullName), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = `Star History request for ${fullName} failed: ${
      error instanceof Error ? error.message : "Unknown network error"
    }`;
    database.writeStarHistoryCache({
      fullName,
      status: "failed",
      checkedAt: requestedAt.toISOString(),
      payload: null,
      errorMessage: message,
    });
    throw new Error(message);
  }

  if (response.status === 404) {
    database.writeStarHistoryCache({
      fullName,
      status: "unavailable",
      checkedAt: requestedAt.toISOString(),
      payload: null,
      errorMessage: null,
    });
    return { status: "unavailable", checked_at: requestedAt.toISOString(), repo: null };
  }

  try {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new TypeError(`unexpected content type ${contentType || "missing"}`);
    }
    const payload = await response.json();
    const repository = parseStarHistoryRepository(payload);
    if (repository.name.toLowerCase() !== fullName.toLowerCase()) {
      throw new TypeError(`response repository ${repository.name} does not match ${fullName}`);
    }
    database.writeStarHistoryCache({
      fullName,
      status: "available",
      checkedAt: requestedAt.toISOString(),
      payload,
      errorMessage: null,
    });
    return { status: "available", checked_at: requestedAt.toISOString(), repo: repository };
  } catch (error) {
    const message = `Star History response for ${fullName} failed validation: ${
      error instanceof Error ? error.message : "Unknown response error"
    }`;
    database.writeStarHistoryCache({
      fullName,
      status: "failed",
      checkedAt: requestedAt.toISOString(),
      payload: null,
      errorMessage: message,
    });
    throw new Error(message);
  }
}
