import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectStarHistories, StarHistoryStore, summarizeStarHistory, type GitHubStarHistory } from "./star-history.ts";

const NOW = Date.parse("2026-09-12T00:00:00.000Z");
const COVER = "2026-06-01T00:00:00.000Z";
const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "history-recovery-")); directories.push(path); return path; }
function pathFor(directory: string, name: string) { return join(directory, createHash("sha256").update(name).digest("hex") + ".json"); }
function history(name: string): GitHubStarHistory {
  return { schema_version: "1.0", full_name: name, fetched_at: new Date(NOW - 86_400_000).toISOString(), complete: true, days: [] };
}
afterEach(() => { directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); vi.restoreAllMocks(); });

it.each([1, 4])("stops after a primary rate limit with stale cache at concurrency %i and counts reused histories", async concurrency => {
  const cacheDirectory = directory();
  const names = Array.from({length:20}, (_, i) => "owner/repo" + i);
  names.forEach(name => writeFileSync(pathFor(cacheDirectory, name), JSON.stringify(history(name))));
  let now = NOW;
  let limited = true;
  const fetchImplementation = vi.fn<typeof fetch>(async () => limited
    ? Response.json({message:"API rate limit exceeded"}, {status:403, headers:{"x-ratelimit-remaining":"0", "x-ratelimit-reset":String((NOW+600_000)/1000)}})
    : Response.json([]));
  const store = new StarHistoryStore({ cacheDirectory, token:"fixture", now:()=>new Date(now), fetchImplementation });
  vi.spyOn(process.stderr,"write").mockImplementation(()=>true);
  const result = await collectStarHistories(names, store, {capturedAt:new Date(now).toISOString(), fetchBudget:20, concurrency});
  expect(result).toMatchObject({fetched:0,reused:20,skipped:0});
  expect(fetchImplementation.mock.calls.length).toBeLessThanOrEqual(concurrency);
  const calls = fetchImplementation.mock.calls.length;
  now += 60_001;
  await store.read(names[0],COVER);
  expect(fetchImplementation).toHaveBeenCalledTimes(calls);
  now = NOW + 600_001;
  limited = false;
  await store.read(names[0],COVER);
  expect(fetchImplementation).toHaveBeenCalledTimes(calls+1);
});

it.each([
  {status:403,headers:{"retry-after":"120","x-ratelimit-remaining":"100"},message:"secondary rate limit",waitMs:120_000},
  {status:403,headers:{"retry-after":"Sat, 12 Sep 2026 00:02:00 GMT"},message:"secondary rate limit",waitMs:120_000},
  {status:429,headers:{},message:"too many requests",waitMs:60_000},
  {status:403,headers:{},message:"You have exceeded a secondary rate limit",waitMs:60_000},
])("honors secondary limits without remaining=0: $status $message", async ({status,headers,message,waitMs}) => {
  let now = NOW;
  const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({message},{status,headers})).mockImplementation(async()=>Response.json([]));
  const store = new StarHistoryStore({cacheDirectory:directory(),token:"fixture",now:()=>new Date(now),fetchImplementation});
  await expect(store.read("owner/a",COVER)).rejects.toThrow(/rate limit/);
  now += waitMs-1;
  await expect(store.read("owner/b",COVER)).rejects.toThrow(/rate limit/);
  expect(fetchImplementation).toHaveBeenCalledTimes(1);
  now++;
  await store.read("owner/b",COVER);
  expect(fetchImplementation).toHaveBeenCalledTimes(2);
});

it("suppresses repository 404 retries briefly, without blocking other repositories or recovery", async () => {
  let now = NOW;
  const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null,{status:404})).mockImplementation(async()=>Response.json([]));
  const store = new StarHistoryStore({cacheDirectory:directory(),token:"fixture",now:()=>new Date(now),fetchImplementation});
  await expect(store.read("owner/missing",COVER)).rejects.toThrow("404");
  await expect(store.read("OWNER/MISSING",COVER)).rejects.toThrow("404");
  await store.read("owner/other",COVER);
  expect(fetchImplementation).toHaveBeenCalledTimes(2);
  now+=60_000;
  await store.read("owner/missing",COVER);
  expect(fetchImplementation).toHaveBeenCalledTimes(3);
});

it.each(["{broken", JSON.stringify({schema_version:"invalid"}), JSON.stringify(history("owner/wrong"))])("quarantines invalid cache and refreshes it: %s", async raw => {
  const cacheDirectory=directory();
  const path=pathFor(cacheDirectory,"owner/a");
  writeFileSync(path,raw);
  const fetchImplementation=vi.fn<typeof fetch>(async()=>Response.json([]));
  const store=new StarHistoryStore({cacheDirectory,token:"fixture",now:()=>new Date(NOW),fetchImplementation});
  vi.spyOn(process.stderr,"write").mockImplementation(()=>true);
  expect(store.readCached("owner/a",COVER)).toBeNull();
  await store.read("owner/a",COVER);
  expect(JSON.parse(readFileSync(path,"utf8")).full_name).toBe("owner/a");
  expect(readFileSync(path+".corrupt","utf8")).toBe(raw);
  expect(fetchImplementation).toHaveBeenCalledOnce();
  expect(readdirSync(cacheDirectory)).toHaveLength(2);
});

it("does not swallow cache filesystem failures in direct or collector reads", async () => {
  const cacheDirectory=directory();
  const fetchImplementation=vi.fn<typeof fetch>(async()=>Response.json([]));
  const store=new StarHistoryStore({cacheDirectory,token:"fixture",fetchImplementation});
  mkdirSync(pathFor(cacheDirectory,"owner/a"));
  await expect(store.read("owner/a",COVER)).rejects.toMatchObject({code:"EISDIR"});
  await expect(collectStarHistories(["owner/a"],store,{capturedAt:new Date(NOW).toISOString(),fetchBudget:1})).rejects.toMatchObject({code:"EISDIR"});
  expect(fetchImplementation).not.toHaveBeenCalled();
});

it("propagates a failed quarantine move instead of pretending the cache is missing", async () => {
  const cacheDirectory=directory();
  const path=pathFor(cacheDirectory,"owner/a");
  writeFileSync(path,"broken");
  const fetchImplementation=vi.fn<typeof fetch>(async()=>Response.json([]));
  const store=new StarHistoryStore({cacheDirectory,token:"fixture",fetchImplementation});
  mkdirSync(path+".corrupt");
  expect(()=>store.readCached("owner/a",COVER)).toThrow();
  expect(readFileSync(path,"utf8")).toBe("broken");
  expect(fetchImplementation).not.toHaveBeenCalled();
});

it("counts quarantined files against the persistent cache budget across restarts", async () => {
  const cacheDirectory=directory();
  const fetchImplementation=vi.fn<typeof fetch>(async()=>Response.json([]));
  const options={cacheDirectory,token:"fixture",fetchImplementation,maxCacheEntries:2};
  const store=new StarHistoryStore(options);
  vi.spyOn(process.stderr,"write").mockImplementation(()=>true);
  for(const name of ["owner/a","owner/b","owner/c"]){
    writeFileSync(pathFor(cacheDirectory,name),"broken");
    await store.read(name,COVER);
    expect(readdirSync(cacheDirectory)).toHaveLength(2);
  }
  const restarted=new StarHistoryStore(options);
  await restarted.read("owner/c",COVER);
  expect(fetchImplementation).toHaveBeenCalledTimes(3);
  expect(readdirSync(cacheDirectory)).toHaveLength(2);
});

it("reports a failed refresh as reused and successful refreshes as fetched", async () => {
  const cacheDirectory=directory();
  writeFileSync(pathFor(cacheDirectory,"owner/stale"),JSON.stringify(history("owner/stale")));
  const fetchImplementation=vi.fn<typeof fetch>(async input=>String(input).includes("/stale/")
    ? new Response(null,{status:502}) : Response.json([]));
  const store=new StarHistoryStore({cacheDirectory,token:"fixture",now:()=>new Date(NOW),fetchImplementation});
  vi.spyOn(process.stderr,"write").mockImplementation(()=>true);
  const result=await collectStarHistories(["owner/stale","owner/new","owner/skipped"],store,{capturedAt:new Date(NOW).toISOString(),fetchBudget:2,concurrency:1});
  expect(result).toMatchObject({fetched:2,reused:1,skipped:0});
  const retry=await collectStarHistories(["owner/stale","owner/new","owner/not-requested"],store,{capturedAt:new Date(NOW).toISOString(),fetchBudget:2,concurrency:1});
  expect(retry).toMatchObject({fetched:1,reused:2,skipped:0});
  expect(fetchImplementation).toHaveBeenCalledTimes(4);
});

it("bounds negative cache entries without suppressing evicted repositories forever", async () => {
  const fetchImplementation=vi.fn<typeof fetch>(async()=>new Response(null,{status:404}));
  const store=new StarHistoryStore({cacheDirectory:directory(),token:"fixture",maxCacheEntries:2,now:()=>new Date(NOW),fetchImplementation});
  for(const name of ["owner/a","owner/b","owner/c","owner/a"]) await expect(store.read(name,COVER)).rejects.toThrow("404");
  expect(fetchImplementation).toHaveBeenCalledTimes(4);
});

it("preserves actual acquisition observation time while cutting days at the ranking cutoff", () => {
  const input={...history("owner/a"),fetched_at:"2026-09-12T00:01:00.000Z",days:[
    {start:"2026-09-10T00:00:00.000Z",end:"2026-09-11T00:00:00.000Z",stars_added:1},
    {start:"2026-09-11T00:00:00.000Z",end:"2026-09-12T00:00:00.000Z",stars_added:2},
  ]};
  const result=summarizeStarHistory(input,"2026-09-11T23:59:00.000Z");
  expect(result.captured_at).toBe(input.fetched_at);
  expect(result.days).toHaveLength(1);
});
