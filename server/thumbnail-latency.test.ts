import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { RepositoryCardCache } from "./card-cache.ts";

it("returns a display-sized WebP instead of the full GitHub card", async () => {
  const directory = mkdtempSync(join(tmpdir(), "thumbnail-size-"));
  try {
    const image = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "red" } }).png().toBuffer();
    const cache = new RepositoryCardCache(directory, { fetchImplementation: async () => new Response(image, { headers: { "Content-Type": "image/png" } }) });
    const result = await cache.read("example/repo", "https://opengraph.githubassets.com/hash/example/repo");
    const metadata = await sharp(result.bytes).metadata();
    expect(result.contentType).toBe("image/webp");
    expect(metadata.width).toBe(252);
    expect(metadata.height).toBe(126);
  } finally { rmSync(directory, { recursive: true }); }
});

describe("thumbnail latency", () => {
  it("shows a stale thumbnail immediately while a slow refresh is pending", async () => {
    const directory = mkdtempSync(join(tmpdir(), "thumbnail-stale-"));
    const red = await sharp({ create: { width: 16, height: 8, channels: 3, background: "red" } }).png().toBuffer();
    const blue = await sharp({ create: { width: 16, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    let time = Date.now();
    let release!: (value: Response) => void;
    const slowResponse = new Promise<Response>(resolve => { release = resolve; });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(red, { headers: { "Content-Type": "image/png" } })).mockImplementationOnce(() => slowResponse);
    const store = new RepositoryCardCache(directory, { fetchImplementation: fetchMock, now: () => time, ttlMs: 1000 });
    const url = "https://opengraph.githubassets.com/hash/example/repo";
    try {
      const first = await store.read("example/repo", url);
      time += 1001;
      const waiting = store.read("example/repo", url);
      const visible = await Promise.race([waiting, new Promise<null>(resolve => setTimeout(() => resolve(null), 100))]);
      release(new Response(blue, { headers: { "Content-Type": "image/png" } }));
      await waiting;
      expect(visible?.bytes).toEqual(first.bytes);
      await vi.waitFor(async () => expect((await store.read("example/repo", url)).bytes.equals(first.bytes)).toBe(false));
    } finally { release(new Response(blue, { headers: { "Content-Type": "image/png" } })); rmSync(directory, { recursive: true }); }
  });
});
