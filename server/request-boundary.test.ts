import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("returns 400 for an invalid request target and serves the next request in the same process", () => {
  const directory = mkdtempSync(join(tmpdir(), "radar-request-boundary-"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Fixture</title>");
  writeFileSync(join(directory, "fixture.json"), "{}");
  const script = join(directory, "probe.mjs");
  const source = new URL("./web-server.ts", import.meta.url).href;
  writeFileSync(script, `
    import { createWebServer } from ${JSON.stringify(source)};
    import { connect } from 'node:net';
    const directory = ${JSON.stringify(directory)};
    const server = createWebServer({cacheDirectory: directory + '/cache', staticDirectory: directory,
      canonicalHost:'fixture.example', githubToken:'fixture', starHistoryHourlyRequestLimit:1,
      internalApiUrl:'http://unused.invalid', legacyHosts:[],
      trafficAnalytics:{apiToken:'fixture',hostname:'fixture.example',zoneId:'0'.repeat(32)}});
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const {port} = server.address();
    const invalid = await new Promise((resolve,reject) => {
      let result='';
      const socket=connect(port,'127.0.0.1',()=>socket.end('GET //[ HTTP/1.1\\r\\nHost: fixture.example\\r\\nConnection: close\\r\\n\\r\\n'));
      socket.on('data',chunk=>result+=chunk); socket.on('error',reject); socket.on('close',()=>resolve(result));
    });
    const normal=await fetch('http://127.0.0.1:'+port+'/fixture.json');
    console.log(JSON.stringify({invalid:invalid.split('\\r\\n')[0],normal:normal.status}));
    await normal.text(); server.close(); server.closeAllConnections();
  `);
  const result = spawnSync(process.execPath, ["--import", "tsx", script], {
    cwd: process.cwd(), encoding: "utf8", timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({ invalid: "HTTP/1.1 400 Bad Request", normal: 200 });
});
