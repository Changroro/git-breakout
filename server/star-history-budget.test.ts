import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { StarHistoryStore } from "./star-history.ts";

it("bounds persisted star-history files and preserves recently reused entries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "history-budget-"));
  try {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json([]));
    const store = new StarHistoryStore({ cacheDirectory: directory, token: "mock", fetchImplementation, maxCacheEntries: 2 });
    const read = (name: string) => store.read("owner/" + name, "2026-08-01T00:00:00.000Z");
    await read("a"); await read("b"); await read("a"); await read("c");
    expect(readdirSync(directory)).toHaveLength(2);
    expect(store.readCached("owner/a", "2026-08-01T00:00:00.000Z")).not.toBeNull();
    expect(store.readCached("owner/b", "2026-08-01T00:00:00.000Z")).toBeNull();
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  } finally { rmSync(directory, { recursive: true }); }
});

it("shares an in-flight fetch across covered history windows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "history-single-flight-"));
  try {
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json([]));
    const store = new StarHistoryStore({ cacheDirectory: directory, token: "mock", fetchImplementation });
    await Promise.all([store.read("owner/a", "2026-08-01T00:00:00.000Z"), store.read("owner/a", "2026-08-03T00:00:00.000Z")]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  } finally { rmSync(directory, { recursive: true }); }
});
