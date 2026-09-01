const CLOUDFLARE_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const CACHE_TTL_MS = 5 * 60 * 1000;
const KST_TIME_ZONE = "Asia/Seoul";

const DAILY_VISITS_QUERY = `
  query DailyVisits($zoneTag: string, $filter: filter) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        traffic: httpRequestsAdaptiveGroups(limit: 1, filter: $filter) {
          sum {
            visits
          }
        }
      }
    }
  }
`;

export type PublicTrafficResponse = {
  schema_version: "1.0";
  date: string;
  time_zone: "Asia/Seoul";
  visits: number;
  generated_at: string;
};

export type CloudflareTrafficConfig = {
  apiToken: string;
  hostname: string;
  zoneId: string;
};

type CloudflareTrafficDependencies = {
  fetchImplementation?: typeof fetch;
  now?: () => Date;
};

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateConfig(config: CloudflareTrafficConfig): void {
  if (config.apiToken.trim() === "") {
    throw new TypeError("Cloudflare Analytics API token is required");
  }
  if (!/^[a-f0-9]{32}$/i.test(config.zoneId)) {
    throw new TypeError("Cloudflare zone id must contain 32 hexadecimal characters");
  }
  const url = new URL(`https://${config.hostname}`);
  if (url.hostname !== config.hostname || url.port !== "" || url.pathname !== "/") {
    throw new TypeError("Traffic hostname must be a hostname without a path or port");
  }
}

function kstDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function startOfKstDate(date: string): string {
  return new Date(`${date}T00:00:00+09:00`).toISOString();
}

function parseVisits(payload: unknown): number {
  const root = requireRecord(payload, "Cloudflare Analytics response");
  const errors = root.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error("Cloudflare Analytics returned GraphQL errors");
  }
  const data = requireRecord(root.data, "Cloudflare Analytics data");
  const viewer = requireRecord(data.viewer, "Cloudflare Analytics viewer");
  if (!Array.isArray(viewer.zones) || viewer.zones.length !== 1) {
    throw new Error("Cloudflare Analytics must return exactly one zone");
  }
  const zone = requireRecord(viewer.zones[0], "Cloudflare Analytics zone");
  if (!Array.isArray(zone.traffic)) {
    throw new TypeError("Cloudflare Analytics traffic must be an array");
  }
  return zone.traffic.reduce((total, row, index) => {
    const group = requireRecord(row, `Cloudflare Analytics traffic row ${index}`);
    const sum = requireRecord(group.sum, `Cloudflare Analytics traffic sum ${index}`);
    if (!Number.isSafeInteger(sum.visits) || (sum.visits as number) < 0) {
      throw new TypeError("Cloudflare Analytics visits must be a non-negative integer");
    }
    return total + (sum.visits as number);
  }, 0);
}

export class CloudflareTrafficAnalytics {
  readonly #config: CloudflareTrafficConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #cached: PublicTrafficResponse | null = null;
  #expiresAt = 0;
  #pending: Promise<PublicTrafficResponse> | null = null;

  constructor(
    config: CloudflareTrafficConfig,
    dependencies: CloudflareTrafficDependencies = {},
  ) {
    validateConfig(config);
    this.#config = { ...config };
    this.#fetch = dependencies.fetchImplementation ?? fetch;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async readDailyTraffic(): Promise<PublicTrafficResponse> {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError("Current time must be a valid date");
    }
    const date = kstDate(now);
    if (this.#cached !== null && this.#cached.date === date && now.getTime() < this.#expiresAt) {
      return { ...this.#cached };
    }
    if (this.#pending !== null) {
      return { ...await this.#pending };
    }
    this.#pending = this.#fetchDailyTraffic(now, date);
    try {
      const traffic = await this.#pending;
      this.#cached = traffic;
      this.#expiresAt = now.getTime() + CACHE_TTL_MS;
      return { ...traffic };
    } finally {
      this.#pending = null;
    }
  }

  async #fetchDailyTraffic(now: Date, date: string): Promise<PublicTrafficResponse> {
    const response = await this.#fetch(CLOUDFLARE_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.#config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: DAILY_VISITS_QUERY,
        variables: {
          zoneTag: this.#config.zoneId,
          filter: {
            clientRequestHTTPHost: this.#config.hostname,
            datetime_geq: startOfKstDate(date),
            datetime_lt: now.toISOString(),
            requestSource: "eyeball",
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Cloudflare Analytics request failed with status ${response.status}`);
    }
    return {
      schema_version: "1.0",
      date,
      time_zone: KST_TIME_ZONE,
      visits: parseVisits(await response.json()),
      generated_at: now.toISOString(),
    };
  }
}
