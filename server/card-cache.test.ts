import sharp from "sharp";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RepositoryCardCache } from "./card-cache.ts";

let red: Buffer;
let blue: Buffer;
beforeAll(async () => {
  red = await sharp({ create: { width: 16, height: 8, channels: 3, background: "red" } }).png().toBuffer();
  blue = await sharp({ create: { width: 16, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
});
const directories: string[] = [];
const stores = new Map<string, RepositoryCardCache>();
async function loadRepositoryCard(name: string, url: string, directory: string, fetchImplementation?: typeof fetch) {
  let store = stores.get(directory);
  if (store === undefined) { store = new RepositoryCardCache(directory, { fetchImplementation }); stores.set(directory, store); }
  return store.read(name, url);
}

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true }));
});

function cacheDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "repository-cards-"));
  directories.push(directory);
  return directory;
}

describe("loadRepositoryCard", () => {
  it("merges concurrent downloads and reuses files after restarting the cache", async () => {
    const fetchMock = vi.fn(async () => new Response(red, {
      headers: { "Content-Type": "image/png" },
    }));
    const directory = cacheDirectory();
    const url = "https://opengraph.githubassets.com/hash/example/radar";
    const store = new RepositoryCardCache(directory, { fetchImplementation: fetchMock as typeof fetch });
    await Promise.all(Array.from({ length: 10 }, () => store.read("example/radar", url)));
    await new RepositoryCardCache(directory, { fetchImplementation: fetchMock as typeof fetch }).read("example/radar", url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used entry within the storage entry budget", async () => {
    const time = Date.now();
    const directory = cacheDirectory();
    const fetchMock = vi.fn(async () => new Response(red, {
      headers: { "Content-Type": "image/png" },
    }));
    const store = new RepositoryCardCache(directory, { fetchImplementation: fetchMock as typeof fetch,
      now: () => time, ttlMs: 1000, maxEntries: 2 });
    const read = (name: string) => store.read(`example/${name}`, `https://opengraph.githubassets.com/hash/example/${name}`);
    await read("a"); await read("b"); await read("a"); await read("c");
    expect(readdirSync(directory)).toHaveLength(2);
    await read("a");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await read("b");
    expect(fetchMock).toHaveBeenCalledTimes(4);

  });

  it("cancels an oversized stream instead of buffering the entire response", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(4)); }, cancel,
    });
    const store = new RepositoryCardCache(cacheDirectory(), { maxBytes: 3,
      fetchImplementation: vi.fn(async () => new Response(stream, { headers: { "Content-Type": "image/png" } })) as typeof fetch });
    await expect(store.read("example/radar", "https://opengraph.githubassets.com/hash/example/radar")).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("keeps unrelated image URLs out of a repository's legitimate cache entry", async () => {
    const fetchMock = vi.fn(async (input) => new Response(String(input).includes("/other/") ? red : blue, {
      headers: { "Content-Type": "image/png" },
    }));
    const directory = cacheDirectory();
    const wrong = "https://repository-images.githubusercontent.com/other/image.png";
    const correct = "https://repository-images.githubusercontent.com/correct/image.png";
    const first = await loadRepositoryCard("example/radar", wrong, directory, fetchMock as typeof fetch);
    const result = await loadRepositoryCard("example/radar", correct, directory, fetchMock as typeof fetch);
    expect(result.bytes.equals(first.bytes)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("reuses a verified repository image when GitHub rotates the generation hash", async () => {
    const fetchMock = vi.fn(async () => new Response(red, {
      headers: { "Content-Type": "image/png" },
    }));
    const directory = cacheDirectory();
    const firstUrl = "https://opengraph.githubassets.com/first/example/radar";
    const rotatedUrl = "https://opengraph.githubassets.com/second/example/radar";

    const first = await loadRepositoryCard("example/radar", firstUrl, directory, fetchMock as typeof fetch);
    const second = await loadRepositoryCard("example/radar", rotatedUrl, directory, fetchMock as typeof fetch);

    expect(first.contentType).toBe("image/webp");
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts repository social preview images hosted by GitHub", async () => {
    const fetchMock = vi.fn(async () => new Response(red, {
      headers: { "Content-Type": "image/png" },
    }));

    await expect(loadRepositoryCard(
      "example/radar",
      "https://repository-images.githubusercontent.com/123/preview.png",
      cacheDirectory(),
      fetchMock as typeof fetch,
    )).resolves.toMatchObject({ contentType: "image/webp" });
  });

  it("rejects image URLs outside GitHub's Open Graph host", async () => {
    await expect(loadRepositoryCard(
      "example/radar",
      "https://example.com/card.png",
      cacheDirectory(),
    )).rejects.toThrow("GitHub Open Graph image host");
  });

  it("rejects malformed repository names", async () => {
    await expect(loadRepositoryCard(
      "radar",
      "https://opengraph.githubassets.com/hash/example/radar",
      cacheDirectory(),
    )).rejects.toThrow("owner/name format");
  });
});
