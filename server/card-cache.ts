import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_STALE_MS = 7 * 86_400_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const CONTENT_TYPES = { "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
const GITHUB_IMAGE_HOSTS = new Set(["opengraph.githubassets.com", "repository-images.githubusercontent.com", "avatars.githubusercontent.com"]);

export type CachedCard = { bytes: Buffer; contentType: keyof typeof CONTENT_TYPES };
type CacheEntry = { path: string; size: number; expiresAt: number; retryAt?: number; contentType: CachedCard["contentType"] };

export class RepositoryCardCache {
  private readonly directory: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<CachedCard>>();
  private readonly missing = new Map<string, { retryAt: number; error: Error }>();
  private bytes = 0;

  constructor(directory: string, options: {
    fetchImplementation?: typeof fetch;
    now?: () => number;
    ttlMs?: number;
    maxBytes?: number;
    maxEntries?: number;
  } = {}) {
    this.directory = resolve(directory);
    this.fetch = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 6 * 3_600_000;
    this.maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 1_000;
    for (const [name, value] of Object.entries({ ttlMs: this.ttlMs, maxBytes: this.maxBytes, maxEntries: this.maxEntries })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
    }
    if (!existsSync(this.directory)) return;
    const files = readdirSync(this.directory).flatMap(name => {
      const match = /^([a-f0-9]{64})\.(gif|jpg|png|webp)$/.exec(name);
      if (match === null) return [];
      const path = join(this.directory, name);
      const stat = statSync(path);
      return [{ key: match[1], path, size: stat.size, modifiedAt: stat.mtimeMs,
        contentType: Object.entries(CONTENT_TYPES).find(([, extension]) => extension === match[2])![0] as CachedCard["contentType"] }];
    }).sort((left, right) => left.modifiedAt - right.modifiedAt);
    for (const file of files) {
      const expiresAt = file.modifiedAt + this.ttlMs;
      if (expiresAt + MAX_STALE_MS <= this.now() || file.size > Math.min(MAX_IMAGE_BYTES, this.maxBytes) || file.size === 0) {
        unlinkSync(file.path);
        continue;
      }
      this.remove(file.key);
      this.entries.set(file.key, { ...file, expiresAt });
      this.bytes += file.size;
    }
    this.trim(0, false);
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    try { unlinkSync(entry.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.entries.delete(key);
    this.bytes -= entry.size;
  }

  private trim(size: number, reserveEntry: boolean): void {
    while (this.entries.size + (reserveEntry ? 1 : 0) > this.maxEntries || this.bytes + size > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) throw new RangeError("Card exceeds the cache storage budget");
      this.remove(oldest);
    }
  }

  async read(repositoryName: string, imageUrl: string): Promise<CachedCard> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName)) {
      throw new TypeError("Repository name must use owner/name format");
    }
    const url = URL.parse(imageUrl);
    if (url === null || url.protocol !== "https:" || !GITHUB_IMAGE_HOSTS.has(url.hostname)
      || url.port !== "" || url.username !== "" || url.password !== "") {
      throw new TypeError("Card URL must use the GitHub Open Graph image host");
    }
    let imageIdentity = url.href;
    if (url.hostname === "opengraph.githubassets.com") {
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts.length !== 3 || parts.slice(1).join("/").toLowerCase() !== repositoryName.toLowerCase()
        || url.search !== "" || url.hash !== "") throw new TypeError("Card URL does not match the repository");
      imageIdentity = "github-generated-card";
    }
    const key = createHash("sha256").update(
      "thumbnail-v2\n" + repositoryName.toLowerCase() + "\n" + imageIdentity,
    ).digest("hex");
    const cached = this.entries.get(key);
    if (cached !== undefined && cached.expiresAt + MAX_STALE_MS > this.now()) {
      if (cached.expiresAt <= this.now() && (cached.retryAt ?? 0) <= this.now()
        && !this.pending.has(key) && this.pending.size < 16) {
        void this.startDownload(url, key).catch(error => {
          cached.retryAt = this.now() + 60_000;
          process.stderr.write("Thumbnail refresh failed for " + repositoryName + ": " + String(error) + "\n");
        });
      }
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { bytes: readFileSync(cached.path), contentType: cached.contentType };
    }
    if (cached !== undefined) this.remove(key);
    const pending = this.pending.get(key);
    if (pending !== undefined) return pending;
    const missing = this.missing.get(key);
    if (missing !== undefined) {
      if (missing.retryAt > this.now()) throw missing.error;
      this.missing.delete(key);
    }
    if (this.pending.size >= 16) throw new RangeError("Card download capacity is exhausted");
    return this.startDownload(url, key);
  }

  private async startDownload(url: URL, key: string): Promise<CachedCard> {
    const request = this.download(url, key);
    this.pending.set(key, request);
    try { return await request; } finally { this.pending.delete(key); }
  }

  private async download(url: URL, key: string): Promise<CachedCard> {
    const response = await this.fetch(url, {
      headers: { "User-Agent": "git-breakout" },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`GitHub Open Graph image request failed with status ${response.status}`);
      if (response.status === 404) {
        while (this.missing.size >= this.maxEntries) this.missing.delete(this.missing.keys().next().value!);
        this.missing.set(key, { retryAt: this.now() + 60_000, error });
      }
      throw error;
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0];
    if (contentType === undefined || !Object.hasOwn(CONTENT_TYPES, contentType)) {
      await response.body?.cancel();
      throw new TypeError(`GitHub Open Graph image returned unsupported type ${String(contentType)}`);
    }
    if (response.body === null) throw new RangeError("GitHub Open Graph image is empty");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > Math.min(MAX_IMAGE_BYTES, this.maxBytes)) {
          await reader.cancel();
          throw new RangeError("GitHub Open Graph image exceeds the size limit");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (length === 0) throw new RangeError("GitHub Open Graph image is empty");
    const bytes = await sharp(Buffer.concat(chunks), { limitInputPixels: 16_777_216 })
      .rotate()
      .resize({ width: 252, height: 126, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 75, effort: 3 })
      .toBuffer();
    const typedContentType = "image/webp" as const;
    this.remove(key);
    this.trim(bytes.length, true);
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, `${key}.${CONTENT_TYPES[typedContentType]}`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, bytes); renameSync(temporary, path); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
    this.entries.set(key, { path, size: bytes.length, expiresAt: this.now() + this.ttlMs, contentType: typedContentType });
    this.bytes += bytes.length;
    return { bytes, contentType: typedContentType };
  }
}
