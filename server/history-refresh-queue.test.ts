import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { StarHistoryStore } from "./star-history.ts";

it("bounds background requests and coalesces the same refresh", async () => {
  const cacheDirectory = mkdtempSync(join(tmpdir(), "history-queue-"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0, maximum = 0;
  const fetchMock = vi.fn<typeof fetch>(async () => {
    active += 1; maximum = Math.max(maximum, active);
    await gate;
    active -= 1;
    return Response.json([]);
  });
  const store = new StarHistoryStore({ cacheDirectory, token: "synthetic", fetchImplementation: fetchMock, hourlyRequestLimit: 20 });
  try {
    for (let i = 0; i < 10; i++) store.refreshInBackground(`owner/repo-${i}`, "2026-08-01T00:00:00.000Z");
    store.refreshInBackground("owner/repo-0", "2026-08-01T00:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    release();
    await vi.waitFor(() => expect(readdirSync(cacheDirectory).filter(name => name.endsWith(".json"))).toHaveLength(10));
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(maximum).toBe(4);
  } finally { release(); rmSync(cacheDirectory, { recursive: true }); }
});
