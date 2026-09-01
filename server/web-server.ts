import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { loadRepositoryCard } from "./card-cache.ts";
import {
  CloudflareTrafficAnalytics,
  type CloudflareTrafficConfig,
} from "./cloudflare-traffic.ts";
import { PublicHistoryApi } from "./public-history.ts";
import type { RankingView } from "../src/lib/repository-filters.ts";

const MAX_PROXY_BODY_BYTES = 32 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 60_000;
const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export type WebServerConfig = {
  cacheDirectory: string;
  internalApiUrl: string;
  staticDirectory: string;
  trafficAnalytics: CloudflareTrafficConfig;
};

type WebServerDependencies = {
  fetchImplementation?: typeof fetch;
};

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  cacheControl = "no-store",
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", cacheControl);
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown server error";
}

function rejectMethod(response: ServerResponse, allowed: string): void {
  response.setHeader("Allow", allowed);
  sendJson(response, 405, { error: "Method not allowed" });
}

function requirePositiveIntegerParameter(
  requestUrl: URL,
  name: string,
  maximum: number,
): number {
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

function requireRankingView(requestUrl: URL): RankingView {
  const view = requestUrl.searchParams.get("view");
  if (view === "momentum" || view === "breakout" || view === "current") {
    return view;
  }
  throw new TypeError("view must be momentum, breakout, or current");
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_PROXY_BODY_BYTES) {
      throw new RangeError(`RPC request body exceeds ${MAX_PROXY_BODY_BYTES} bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function forwardedHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const name of ["accept", "authorization", "content-type", "prefer", "range", "x-client-info"]) {
    const value = request.headers[name];
    if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  return headers;
}

async function proxyRpc(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  internalApiUrl: string,
  fetchImplementation: typeof fetch,
): Promise<void> {
  if (!/^\/rpc\/[a-z][a-z0-9_]*$/.test(requestUrl.pathname)) {
    sendJson(response, 404, { error: "RPC route not found" });
    return;
  }
  try {
    const body = await readRequestBody(request);
    const upstream = await fetchImplementation(`${internalApiUrl}${requestUrl.pathname}${requestUrl.search}`, {
      method: request.method,
      headers: forwardedHeaders(request),
      body,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    response.statusCode = upstream.status;
    for (const name of ["content-range", "content-type", "location", "preference-applied", "www-authenticate"]) {
      const value = upstream.headers.get(name);
      if (value !== null) {
        response.setHeader(name, value);
      }
    }
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    sendJson(response, error instanceof RangeError ? 413 : 502, { error: errorMessage(error) });
  }
}

function resolveStaticFile(staticDirectory: string, pathname: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relativePath = ["/", "/archive", "/track-record"].includes(decodedPath)
    ? "index.html"
    : decodedPath.slice(1);
  const filePath = resolve(staticDirectory, relativePath);
  const staticRoot = resolve(staticDirectory);
  if (filePath !== staticRoot && !filePath.startsWith(`${staticRoot}${sep}`)) {
    return null;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return null;
  }
  return filePath;
}

function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  staticDirectory: string,
  pathname: string,
): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    rejectMethod(response, "GET, HEAD");
    return;
  }
  const filePath = resolveStaticFile(staticDirectory, pathname);
  if (filePath === null) {
    sendJson(response, 404, { error: "Page not found" });
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader(
    "Cache-Control",
    ["/", "/archive", "/track-record", "/theme-init.js", "/locale-init.js"].includes(pathname)
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  );
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).on("error", (error) => {
    if (!response.headersSent) {
      sendJson(response, 500, { error: error.message });
      return;
    }
    response.destroy(error);
  }).pipe(response);
}

export function createWebServer(
  config: WebServerConfig,
  dependencies: WebServerDependencies = {},
): Server {
  const staticDirectory = resolve(config.staticDirectory);
  if (!existsSync(resolve(staticDirectory, "index.html"))) {
    throw new Error(`Static index is missing from ${staticDirectory}`);
  }
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const historyApi = new PublicHistoryApi({
    baseUrl: config.internalApiUrl,
    fetchImplementation,
  });
  const trafficAnalytics = new CloudflareTrafficAnalytics(config.trafficAnalytics, {
    fetchImplementation,
  });
  const cardCacheDirectory = resolve(config.cacheDirectory, "repository-cards");

  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/health") {
      if (request.method !== "GET") {
        rejectMethod(response, "GET");
        return;
      }
      try {
        sendJson(response, 200, await historyApi.readHealth());
      } catch (error) {
        sendJson(response, 503, { error: errorMessage(error) });
      }
      return;
    }
    if (requestUrl.pathname === "/api/timeline") {
      if (request.method !== "GET") {
        rejectMethod(response, "GET");
        return;
      }
      try {
        sendJson(response, 200, await historyApi.readTimeline());
      } catch (error) {
        sendJson(response, 502, { error: errorMessage(error) });
      }
      return;
    }
    if (requestUrl.pathname === "/api/traffic") {
      if (request.method !== "GET") {
        rejectMethod(response, "GET");
        return;
      }
      try {
        sendJson(
          response,
          200,
          await trafficAnalytics.readDailyTraffic(),
          "public, max-age=300",
        );
      } catch (error) {
        process.stderr.write(`Traffic analytics failed: ${errorMessage(error)}\n`);
        sendJson(response, 503, { error: "Traffic statistics are unavailable" });
      }
      return;
    }
    if (requestUrl.pathname === "/api/snapshot") {
      if (request.method !== "GET") {
        rejectMethod(response, "GET");
        return;
      }
      const snapshotId = requestUrl.searchParams.get("id");
      if (snapshotId === null) {
        sendJson(response, 400, { error: "Snapshot id is required" });
        return;
      }
      try {
        sendJson(
          response,
          200,
          await historyApi.readSnapshot(snapshotId),
          "public, max-age=31536000, immutable",
        );
      } catch (error) {
        sendJson(response, error instanceof RangeError ? 404 : 502, { error: errorMessage(error) });
      }
      return;
    }
    if (requestUrl.pathname === "/api/ranking") {
      if (request.method !== "GET") {
        rejectMethod(response, "GET");
        return;
      }
      try {
        const snapshotId = requestUrl.searchParams.get("snapshot");
        if (snapshotId === null) {
          throw new TypeError("snapshot is required");
        }
        const ranking = await historyApi.readRankingPage({
          snapshotId,
          page: requirePositiveIntegerParameter(requestUrl, "page", 1_000_000),
          pageSize: requirePositiveIntegerParameter(requestUrl, "page_size", 100),
          language: requestUrl.searchParams.get("language"),
          topic: requestUrl.searchParams.get("topic"),
          view: requireRankingView(requestUrl),
        });
        sendJson(response, 200, ranking, "no-store");
      } catch (error) {
        sendJson(response, error instanceof TypeError || error instanceof RangeError ? 400 : 502, {
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/api/search") {
      if (request.method !== "GET") {
        rejectMethod(response, "GET");
        return;
      }
      try {
        const snapshotId = requestUrl.searchParams.get("snapshot");
        const query = requestUrl.searchParams.get("query");
        if (snapshotId === null || query === null) {
          throw new TypeError("snapshot and query are required");
        }
        const search = await historyApi.searchRepositories(
          snapshotId,
          query,
          requirePositiveIntegerParameter(requestUrl, "limit", 20),
        );
        sendJson(response, 200, search, "public, max-age=31536000, immutable");
      } catch (error) {
        sendJson(response, error instanceof TypeError || error instanceof RangeError ? 400 : 502, {
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/api/archive") {
      if (request.method !== "GET") {
        rejectMethod(response, "GET");
        return;
      }
      try {
        const archive = await historyApi.readArchivePage({
          page: requirePositiveIntegerParameter(requestUrl, "page", 1_000_000),
          pageSize: requirePositiveIntegerParameter(requestUrl, "page_size", 100),
          query: requestUrl.searchParams.get("query"),
        });
        sendJson(response, 200, archive, "no-store");
      } catch (error) {
        sendJson(response, error instanceof TypeError || error instanceof RangeError ? 400 : 502, {
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/api/card") {
      if (request.method !== "GET") {
        rejectMethod(response, "GET");
        return;
      }
      try {
        const repositoryName = requestUrl.searchParams.get("repository");
        const imageUrl = requestUrl.searchParams.get("url");
        if (repositoryName === null) {
          throw new TypeError("Repository name is required");
        }
        if (imageUrl === null) {
          throw new TypeError("Card URL is required");
        }
        const card = await loadRepositoryCard(repositoryName, imageUrl, cardCacheDirectory, fetchImplementation);
        response.statusCode = 200;
        response.setHeader("Content-Type", card.contentType);
        response.setHeader("Cache-Control", "public, max-age=21600, immutable");
        response.end(card.bytes);
      } catch (error) {
        sendJson(response, 502, { error: errorMessage(error) });
      }
      return;
    }
    if (requestUrl.pathname === "/api/star-series") {
      if (request.method !== "GET") {
        rejectMethod(response, "GET");
        return;
      }
      const snapshotId = requestUrl.searchParams.get("snapshot");
      const repositoryNames = requestUrl.searchParams.getAll("repository");
      if (snapshotId === null) {
        sendJson(response, 400, { error: "Snapshot id is required" });
        return;
      }
      try {
        sendJson(
          response,
          200,
          await historyApi.readStarSeries(snapshotId, repositoryNames),
          "public, max-age=31536000, immutable",
        );
      } catch (error) {
        sendJson(response, error instanceof TypeError ? 400 : 502, { error: errorMessage(error) });
      }
      return;
    }
    if (requestUrl.pathname.startsWith("/rpc/")) {
      await proxyRpc(
        request,
        response,
        requestUrl,
        historyApi.baseUrl,
        fetchImplementation,
      );
      return;
    }
    serveStatic(request, response, staticDirectory, requestUrl.pathname);
  });
  return server;
}
