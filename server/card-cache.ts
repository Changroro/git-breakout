import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const CONTENT_TYPES = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;
const GITHUB_IMAGE_HOSTS = new Set([
  "opengraph.githubassets.com",
  "repository-images.githubusercontent.com",
]);

export type CachedCard = {
  bytes: Buffer;
  contentType: keyof typeof CONTENT_TYPES;
};

function validateImageUrl(value: string): URL {
  const url = URL.parse(value);
  if (
    url === null ||
    url.protocol !== "https:" ||
    !GITHUB_IMAGE_HOSTS.has(url.hostname)
  ) {
    throw new TypeError("Card URL must use the GitHub Open Graph image host");
  }
  return url;
}

function cacheKey(repositoryName: string): string {
  const segments = repositoryName.split("/");
  if (
    repositoryName.trim() !== repositoryName ||
    segments.length !== 2 ||
    segments.some((segment) => segment.length === 0)
  ) {
    throw new TypeError("Repository name must use owner/name format");
  }
  return createHash("sha256").update(repositoryName.toLowerCase()).digest("hex");
}

function readCachedCard(cacheDirectory: string, key: string): CachedCard | null {
  for (const [contentType, extension] of Object.entries(CONTENT_TYPES)) {
    const filePath = join(cacheDirectory, `${key}.${extension}`);
    if (existsSync(filePath)) {
      return {
        bytes: readFileSync(filePath),
        contentType: contentType as keyof typeof CONTENT_TYPES,
      };
    }
  }
  return null;
}

export async function loadRepositoryCard(
  repositoryName: string,
  imageUrl: string,
  cacheDirectory: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<CachedCard> {
  const url = validateImageUrl(imageUrl);
  const key = cacheKey(repositoryName);
  const cached = readCachedCard(cacheDirectory, key);
  if (cached !== null) {
    return cached;
  }

  const response = await fetchImplementation(url, {
    headers: { "User-Agent": "ai-trend-radar/0.0.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const resetHeader = response.headers.get("x-ratelimit-reset");
    const resetAt = resetHeader === null ? null : new Date(Number(resetHeader) * 1000);
    const resetMessage = resetAt !== null && Number.isFinite(resetAt.getTime())
      ? `; rate limit resets at ${resetAt.toISOString()}`
      : "";
    throw new Error(
      `GitHub Open Graph image request failed with status ${response.status}${resetMessage}`,
    );
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType === undefined || !(contentType in CONTENT_TYPES)) {
    throw new TypeError(`GitHub Open Graph image returned unsupported type ${String(contentType)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new RangeError(`GitHub Open Graph image size ${bytes.length} is invalid`);
  }
  mkdirSync(cacheDirectory, { recursive: true });
  const typedContentType = contentType as keyof typeof CONTENT_TYPES;
  const filePath = join(cacheDirectory, `${key}.${CONTENT_TYPES[typedContentType]}`);
  try {
    writeFileSync(filePath, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const concurrentlyCached = readCachedCard(cacheDirectory, key);
    if (concurrentlyCached === null) {
      throw new Error(`Concurrent card cache write did not create ${filePath}`);
    }
    return concurrentlyCached;
  }
  return { bytes, contentType: typedContentType };
}
