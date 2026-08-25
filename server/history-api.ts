import { resolve } from "node:path";
import type { Connect, Plugin, PreviewServer, ViteDevServer } from "vite";
import { loadRepositoryCard } from "./card-cache.ts";
import { HistoryDatabase } from "./history.ts";

function attachHistoryApi(
  middlewares: Connect.Server,
  httpServer: ViteDevServer["httpServer"] | PreviewServer["httpServer"],
): void {
  const database = new HistoryDatabase(resolve(process.cwd(), "data", "ranking-history.sqlite"));
  const cardCacheDirectory = resolve(process.cwd(), "data", "repository-cards");
  database.seedSamplesIfEmpty();
  httpServer?.once("close", () => database.close());

  middlewares.use("/api/history", (request, response) => {
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
      response.end(JSON.stringify(database.readHistory()));
    } catch (error) {
      response.statusCode = 500;
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : "Unknown history error" }),
      );
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
