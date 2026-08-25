import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRepositoryCard } from "./card-cache.ts";

const directories: string[] = [];

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true }));
});

function cacheDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "repository-cards-"));
  directories.push(directory);
  return directory;
}

describe("loadRepositoryCard", () => {
  it("downloads a repository card once even when GitHub rotates its image URL", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "image/png" },
    }));
    const directory = cacheDirectory();
    const firstUrl = "https://opengraph.githubassets.com/first/example/radar";
    const rotatedUrl = "https://opengraph.githubassets.com/second/example/radar";

    const first = await loadRepositoryCard("example/radar", firstUrl, directory, fetchMock as typeof fetch);
    const second = await loadRepositoryCard("example/radar", rotatedUrl, directory, fetchMock as typeof fetch);

    expect(first).toEqual({ bytes: Buffer.from([1, 2, 3]), contentType: "image/png" });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts repository social preview images hosted by GitHub", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "image/png" },
    }));

    await expect(loadRepositoryCard(
      "example/radar",
      "https://repository-images.githubusercontent.com/123/preview.png",
      cacheDirectory(),
      fetchMock as typeof fetch,
    )).resolves.toEqual({ bytes: Buffer.from([1, 2, 3]), contentType: "image/png" });
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
