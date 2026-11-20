import { resolve } from "node:path";
import { createWebServer } from "./web-server.ts";

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("GIT_BREAKOUT_WEB_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function readPositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function readHostList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  const hosts = value.split(",").map((host) => host.trim());
  if (hosts.some((host) => host === "")) {
    throw new TypeError("GIT_BREAKOUT_LEGACY_HOSTS must be a comma-separated hostname list");
  }
  return hosts;
}

const port = readPort(requireEnvironment("GIT_BREAKOUT_WEB_PORT"));
const publicHost = requireEnvironment("GIT_BREAKOUT_PUBLIC_HOST");
const server = createWebServer({
  cacheDirectory: resolve(requireEnvironment("GIT_BREAKOUT_WEB_CACHE_DIR")),
  canonicalHost: publicHost,
  githubToken: requireEnvironment("GITHUB_TOKEN"),
  starHistoryHourlyRequestLimit: readPositiveInteger(
    requireEnvironment("GIT_BREAKOUT_STAR_HISTORY_WEB_HOURLY_LIMIT"),
    "GIT_BREAKOUT_STAR_HISTORY_WEB_HOURLY_LIMIT",
  ),
  internalApiUrl: requireEnvironment("GIT_BREAKOUT_INTERNAL_API_URL"),
  legacyHosts: readHostList(process.env.GIT_BREAKOUT_LEGACY_HOSTS),
  staticDirectory: resolve(requireEnvironment("GIT_BREAKOUT_STATIC_DIR")),
  trafficAnalytics: {
    apiToken: requireEnvironment("CLOUDFLARE_ANALYTICS_TOKEN"),
    hostname: publicHost,
    zoneId: requireEnvironment("CLOUDFLARE_ZONE_ID"),
  },
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`Git Breakout web server listening on port ${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close((error) => {
    if (error !== undefined) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }));
}
