import { resolve } from "node:path";
import type { Connect, Plugin, PreviewServer, ViteDevServer } from "vite";
import { loadRepositoryCard } from "./card-cache.ts";
import { HistoryDatabase } from "./history.ts";
import { buildLocalRankingPage, buildLocalRepositorySearch } from "./local-ranking.ts";
import { parseRankingView } from "../src/lib/repository-filters.ts";

function requirePositiveInteger(requestUrl: URL, name: string, maximum: number): number {
  const value = requestUrl.searchParams.get(name);
  if (value === null || !/^\d+$/.test(value)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new RangeError(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function attachHistoryApi(
  middlewares: Connect.Server,
  httpServer: ViteDevServer["httpServer"] | PreviewServer["httpServer"],
): void {
  const database = new HistoryDatabase(resolve(process.cwd(), "data", "ranking-history.sqlite"));
  const cardCacheDirectory = resolve(process.cwd(), "data", "repository-cards");
  httpServer?.once("close", () => database.close());

  middlewares.use("/api/timeline", (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    try {
      response.statusCode = 200;
      const history = database.readHistory();
      response.end(JSON.stringify({
        schema_version: "1.0",
        snapshots: history.snapshots.map((snapshot) => ({
          id: snapshot.id,
          captured_at: snapshot.captured_at,
          source: snapshot.source,
          repository_count: snapshot.repositories.length,
        })),
      }));
    } catch (error) {
      response.statusCode = 500;
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : "Unknown history error" }),
      );
    }
  });

  middlewares.use("/api/snapshot", (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const requestUrl = new URL(request.url ?? "", "http://localhost");
    const snapshotId = requestUrl.searchParams.get("id");
    if (snapshotId === null) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Snapshot id is required" }));
      return;
    }
    try {
      const snapshot = database.readHistory().snapshots.find((item) => item.id === snapshotId);
      if (snapshot === undefined) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: `Snapshot ${snapshotId} does not exist` }));
        return;
      }
      response.statusCode = 200;
      response.end(JSON.stringify(snapshot));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown snapshot error",
      }));
    }
  });

  middlewares.use("/api/ranking", (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const requestUrl = new URL(request.url ?? "", "http://localhost");
      const snapshotId = requestUrl.searchParams.get("snapshot");
      if (snapshotId === null) {
        throw new TypeError("snapshot is required");
      }
      const snapshot = database.readHistory().snapshots.find((item) => item.id === snapshotId);
      if (snapshot === undefined) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: `Snapshot ${snapshotId} does not exist` }));
        return;
      }
      response.statusCode = 200;
      response.end(JSON.stringify(buildLocalRankingPage({
        snapshot,
        page: requirePositiveInteger(requestUrl, "page", 1_000_000),
        pageSize: requirePositiveInteger(requestUrl, "page_size", 100),
        filters: {
          language: requestUrl.searchParams.get("language"),
          topic: requestUrl.searchParams.get("topic"),
        },
        view: parseRankingView(requestUrl.search),
      })));
    } catch (error) {
      response.statusCode = error instanceof TypeError || error instanceof RangeError ? 400 : 500;
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown ranking error",
      }));
    }
  });

  middlewares.use("/api/search", (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const requestUrl = new URL(request.url ?? "", "http://localhost");
      const snapshotId = requestUrl.searchParams.get("snapshot");
      const query = requestUrl.searchParams.get("query");
      if (snapshotId === null || query === null) {
        throw new TypeError("snapshot and query are required");
      }
      const snapshot = database.readHistory().snapshots.find((item) => item.id === snapshotId);
      if (snapshot === undefined) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: `Snapshot ${snapshotId} does not exist` }));
        return;
      }
      response.statusCode = 200;
      response.end(JSON.stringify(buildLocalRepositorySearch(
        snapshot,
        query,
        requirePositiveInteger(requestUrl, "limit", 20),
      )));
    } catch (error) {
      response.statusCode = error instanceof TypeError || error instanceof RangeError ? 400 : 500;
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown repository search error",
      }));
    }
  });

  middlewares.use("/api/archive", (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const requestUrl = new URL(request.url ?? "", "http://localhost");
      response.statusCode = 200;
      response.end(JSON.stringify(database.readArchivePage(
        requirePositiveInteger(requestUrl, "page", 1_000_000),
        requirePositiveInteger(requestUrl, "page_size", 100),
        requestUrl.searchParams.get("query"),
      )));
    } catch (error) {
      response.statusCode = error instanceof TypeError || error instanceof RangeError ? 400 : 500;
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown archive error",
      }));
    }
  });

  middlewares.use("/api/card", async (request, response) => {
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const requestUrl = new URL(request.url ?? "", "http://localhost");
      const repositoryName = requestUrl.searchParams.get("repository");
      const imageUrl = requestUrl.searchParams.get("url");
      if (repositoryName === null) {
        throw new TypeError("Repository name is required");
      }
      if (imageUrl === null) {
        throw new TypeError("Card URL is required");
      }
      const card = await loadRepositoryCard(repositoryName, imageUrl, cardCacheDirectory);
      response.statusCode = 200;
      response.setHeader("Content-Type", card.contentType);
      response.setHeader("Cache-Control", "public, max-age=21600, immutable");
      response.end(card.bytes);
    } catch (error) {
      response.statusCode = 502;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown card image error",
      }));
    }
  });

  middlewares.use("/api/star-series", (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const requestUrl = new URL(request.url ?? "", "http://localhost");
    const snapshotId = requestUrl.searchParams.get("snapshot");
    const repositoryNames = requestUrl.searchParams.getAll("repository");
    if (snapshotId === null) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Snapshot id is required" }));
      return;
    }

    try {
      const snapshot = database.readHistory().snapshots.find((item) => item.id === snapshotId);
      if (snapshot === undefined) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: `Snapshot ${snapshotId} does not exist` }));
        return;
      }
      response.statusCode = 200;
      response.end(JSON.stringify(database.readStarSeries(repositoryNames, snapshot.captured_at)));
    } catch (error) {
      response.statusCode = error instanceof TypeError ? 400 : 500;
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown star series error",
      }));
    }
  });
}

export function historyApiPlugin(): Plugin {
  return {
    name: "ranking-history-api",
    configureServer(server) {
      attachHistoryApi(server.middlewares, server.httpServer);
    },
    configurePreviewServer(server) {
      attachHistoryApi(server.middlewares, server.httpServer);
    },
  };
}
