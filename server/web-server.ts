import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { loadRepositoryCard } from "./card-cache.ts";
import {
  CloudflareTrafficAnalytics,
  type CloudflareTrafficConfig,
} from "./cloudflare-traffic.ts";
import { PublicHistoryApi } from "./public-history.ts";
import type {
  GitHubTrendingPeriod,
  RankingView,
} from "../src/lib/repository-filters.ts";

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
  ".xml": "application/xml; charset=utf-8",
};

type DocumentMetadata = {
  description: string;
  title: string;
};

type RepositoryShareMetadata = DocumentMetadata & {
  imageAlt: string;
  imageUrl: string;
  socialUrl: string;
};

const GITHUB_CARD_HOSTS = new Set([
  "opengraph.githubassets.com",
  "repository-images.githubusercontent.com",
]);

const RANKING_VIEW_NAMES: Record<RankingView, string> = {
  breakout: "Breakout",
  current: "Current heat",
  github: "GitHub Trending",
  momentum: "Momentum",
};

const DOCUMENT_METADATA: Record<"/" | "/archive" | "/track-record", DocumentMetadata> = {
  "/": {
    title: "Git Breakout: Rising GitHub repository rankings",
    description: "Git Breakout discovers rising GitHub repositories using observed growth, activity, and transparent ranking signals.",
  },
  "/archive": {
    title: "GitHub Repository Ranking Archive | Git Breakout",
    description: "Browse repositories previously observed by Git Breakout and reopen their historical ranking snapshots.",
  },
  "/track-record": {
    title: "GitHub Trending Early Discovery Track Record | Git Breakout",
    description: "Review verifiable Git Breakout observations recorded before repositories appeared in GitHub Trending Daily.",
  },
};

export type WebServerConfig = {
  cacheDirectory: string;
  canonicalHost: string;
  internalApiUrl: string;
  legacyHosts: readonly string[];
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

function requireHostname(value: string, name: string): string {
  const hostname = value.trim().toLowerCase();
  const url = new URL(`https://${hostname}`);
  if (url.hostname !== hostname || url.port !== "" || url.pathname !== "/") {
    throw new TypeError(`${name} must be a hostname without a path or port`);
  }
  return hostname;
}

function requestHostname(request: IncomingMessage): string | null {
  const host = request.headers.host;
  if (host === undefined) {
    return null;
  }
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function redirectLegacyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  canonicalHost: string,
  legacyHosts: ReadonlySet<string>,
): boolean {
  if (
    (request.method !== "GET" && request.method !== "HEAD")
    || !legacyHosts.has(requestHostname(request) ?? "")
  ) {
    return false;
  }
  const targetPathname = normalizeDocumentPath(requestUrl.pathname) ?? requestUrl.pathname;
  response.statusCode = 301;
  response.setHeader("Cache-Control", "public, max-age=86400");
  response.setHeader("Location", `https://${canonicalHost}${targetPathname}${requestUrl.search}`);
  response.end();
  return true;
}

function normalizeDocumentPath(pathname: string): "/archive" | "/track-record" | null {
  if (pathname === "/archive/") {
    return "/archive";
  }
  if (pathname === "/track-record/") {
    return "/track-record";
  }
  return null;
}

function redirectNormalizedDocument(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  canonicalHost: string,
): boolean {
  const pathname = normalizeDocumentPath(requestUrl.pathname);
  if (pathname === null || (request.method !== "GET" && request.method !== "HEAD")) {
    return false;
  }
  response.statusCode = 301;
  response.setHeader("Cache-Control", "public, max-age=86400");
  response.setHeader("Location", `https://${canonicalHost}${pathname}${requestUrl.search}`);
  response.end();
  return true;
}

function replaceRequired(html: string, pattern: RegExp, replacement: string, field: string): string {
  if (!pattern.test(html)) {
    throw new Error(`Static index is missing ${field}`);
  }
  return html.replace(pattern, replacement);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function repositoryShareMetadata(
  requestUrl: URL,
  canonicalHost: string,
): RepositoryShareMetadata | null {
  const fullName = requestUrl.searchParams.get("share_repository");
  const imageValue = requestUrl.searchParams.get("share_image");
  const rankValue = requestUrl.searchParams.get("share_rank");
  const viewValue = requestUrl.searchParams.get("share_view");
  if (fullName === null || imageValue === null || rankValue === null || viewValue === null) {
    return null;
  }
  const imageUrl = URL.parse(imageValue);
  if (
    !/^[^/\s]+\/[^/\s]+$/.test(fullName)
    || imageUrl === null
    || imageUrl.protocol !== "https:"
    || !GITHUB_CARD_HOSTS.has(imageUrl.hostname)
    || !/^\d+$/.test(rankValue)
    || !(viewValue in RANKING_VIEW_NAMES)
  ) {
    return null;
  }
  const rank = Number(rankValue);
  if (!Number.isSafeInteger(rank) || rank < 1) {
    return null;
  }
  const view = viewValue as RankingView;
  return {
    title: `${fullName} · Git Breakout`,
    description: `#${rank} in Git Breakout ${RANKING_VIEW_NAMES[view]} rankings`,
    imageAlt: `${fullName} GitHub repository card`,
    imageUrl: imageUrl.toString(),
    socialUrl: `https://${canonicalHost}${requestUrl.pathname}${requestUrl.search}`,
  };
}

function renderDocumentHtml(indexTemplate: string, requestUrl: URL, canonicalHost: string): string {
  const pathname = requestUrl.pathname as keyof typeof DOCUMENT_METADATA;
  const documentMetadata = DOCUMENT_METADATA[pathname];
  if (documentMetadata === undefined) {
    throw new RangeError(`Document metadata is unavailable for ${requestUrl.pathname}`);
  }
  const shareMetadata = pathname === "/" ? repositoryShareMetadata(requestUrl, canonicalHost) : null;
  const metadata = shareMetadata ?? documentMetadata;
  const canonicalUrl = `https://${canonicalHost}${pathname}`;
  const socialUrl = shareMetadata?.socialUrl ?? canonicalUrl;
  const imageUrl = shareMetadata?.imageUrl ?? `https://${canonicalHost}/gitbreakout-social-card.png`;
  const imageAlt = shareMetadata?.imageAlt ?? "Git Breakout — rising GitHub repository rankings";
  const robots = requestUrl.search === "" ? "index,follow" : "noindex,follow";
  const title = escapeHtmlAttribute(metadata.title);
  const description = escapeHtmlAttribute(metadata.description);
  let html = replaceRequired(indexTemplate, /<title>[^<]*<\/title>/, `<title>${title}</title>`, "title");
  html = replaceRequired(html, /<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${description}" />`, "description");
  html = replaceRequired(html, /<meta name="robots" content="[^"]*" \/>/, `<meta name="robots" content="${robots}" />`, "robots metadata");
  html = replaceRequired(html, /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${title}" />`, "Open Graph title");
  html = replaceRequired(html, /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${description}" />`, "Open Graph description");
  html = replaceRequired(html, /<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${escapeHtmlAttribute(socialUrl)}" />`, "Open Graph URL");
  html = replaceRequired(html, /<meta property="og:image" content="[^"]*" \/>/, `<meta property="og:image" content="${escapeHtmlAttribute(imageUrl)}" />`, "Open Graph image");
  html = replaceRequired(html, /<meta property="og:image:alt" content="[^"]*" \/>/, `<meta property="og:image:alt" content="${escapeHtmlAttribute(imageAlt)}" />`, "Open Graph image alt");
  if (shareMetadata !== null) {
    html = replaceRequired(html, /\s*<meta property="og:image:type" content="[^"]*" \/>/, "", "Open Graph image type");
    html = replaceRequired(html, /\s*<meta property="og:image:width" content="[^"]*" \/>/, "", "Open Graph image width");
    html = replaceRequired(html, /\s*<meta property="og:image:height" content="[^"]*" \/>/, "", "Open Graph image height");
  }
  html = replaceRequired(html, /<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${title}" />`, "Twitter title");
  html = replaceRequired(html, /<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${description}" />`, "Twitter description");
  html = replaceRequired(html, /<meta name="twitter:image" content="[^"]*" \/>/, `<meta name="twitter:image" content="${escapeHtmlAttribute(imageUrl)}" />`, "Twitter image");
  html = replaceRequired(html, /<meta name="twitter:image:alt" content="[^"]*" \/>/, `<meta name="twitter:image:alt" content="${escapeHtmlAttribute(imageAlt)}" />`, "Twitter image alt");
  return replaceRequired(html, /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${canonicalUrl}" />`, "canonical link");
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
  if (view === "momentum" || view === "breakout" || view === "current" || view === "github") {
    return view;
  }
  throw new TypeError("view must be breakout, momentum, current, or github");
}

function requireGitHubTrendingPeriod(
  requestUrl: URL,
  view: RankingView,
): GitHubTrendingPeriod | null {
  const period = requestUrl.searchParams.get("period");
  if (view !== "github") {
    if (period !== null) {
      throw new TypeError("period is only valid for the github view");
    }
    return null;
  }
  if (period === "daily" || period === "weekly" || period === "monthly") {
    return period;
  }
  throw new TypeError("period must be daily, weekly, or monthly for the github view");
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
  indexTemplate: string,
  canonicalHost: string,
  staticDirectory: string,
  requestUrl: URL,
): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    rejectMethod(response, "GET, HEAD");
    return;
  }
  const filePath = resolveStaticFile(staticDirectory, requestUrl.pathname);
  if (filePath === null) {
    sendJson(response, 404, { error: "Page not found" });
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader(
    "Cache-Control",
    ["/", "/archive", "/track-record", "/theme-init.js", "/locale-init.js"].includes(requestUrl.pathname)
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  );
  if (["/", "/archive", "/track-record"].includes(requestUrl.pathname)) {
    const html = renderDocumentHtml(indexTemplate, requestUrl, canonicalHost);
    response.setHeader("Content-Length", Buffer.byteLength(html));
    response.end(request.method === "HEAD" ? undefined : html);
    return;
  }
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
  const indexPath = resolve(staticDirectory, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`Static index is missing from ${staticDirectory}`);
  }
  const indexTemplate = readFileSync(indexPath, "utf8");
  const canonicalHost = requireHostname(config.canonicalHost, "Canonical host");
  const legacyHosts = new Set(config.legacyHosts.map((host) => requireHostname(host, "Legacy host")));
  if (legacyHosts.has(canonicalHost)) {
    throw new TypeError("Canonical host cannot also be a legacy host");
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
    if (redirectLegacyRequest(request, response, requestUrl, canonicalHost, legacyHosts)) {
      return;
    }
    if (redirectNormalizedDocument(request, response, requestUrl, canonicalHost)) {
      return;
    }
    if (
      requestUrl.pathname === "/health"
      || requestUrl.pathname.startsWith("/api/")
      || requestUrl.pathname.startsWith("/rpc/")
    ) {
      response.setHeader("X-Robots-Tag", "noindex, nofollow");
    }
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
        const view = requireRankingView(requestUrl);
        const ranking = await historyApi.readRankingPage({
          snapshotId,
          page: requirePositiveIntegerParameter(requestUrl, "page", 1_000_000),
          pageSize: requirePositiveIntegerParameter(requestUrl, "page_size", 100),
          language: requestUrl.searchParams.get("language"),
          topic: requestUrl.searchParams.get("topic"),
          view,
          period: requireGitHubTrendingPeriod(requestUrl, view),
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
    serveStatic(request, response, indexTemplate, canonicalHost, staticDirectory, requestUrl);
  });
  return server;
}
