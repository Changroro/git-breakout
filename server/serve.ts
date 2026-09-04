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
    throw new RangeError("TREND_RADAR_WEB_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function readHostList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }
  const hosts = value.split(",").map((host) => host.trim());
  if (hosts.some((host) => host === "")) {
    throw new TypeError("TREND_RADAR_LEGACY_HOSTS must be a comma-separated hostname list");
  }
  return hosts;
}

const port = readPort(requireEnvironment("TREND_RADAR_WEB_PORT"));
const publicHost = requireEnvironment("TREND_RADAR_PUBLIC_HOST");
const server = createWebServer({
  cacheDirectory: resolve(requireEnvironment("TREND_RADAR_WEB_CACHE_DIR")),
  canonicalHost: publicHost,
  internalApiUrl: requireEnvironment("TREND_RADAR_INTERNAL_API_URL"),
  legacyHosts: readHostList(process.env.TREND_RADAR_LEGACY_HOSTS),
  staticDirectory: resolve(requireEnvironment("TREND_RADAR_STATIC_DIR")),
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
