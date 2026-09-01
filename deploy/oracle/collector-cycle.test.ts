import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Oracle collector scheduling", () => {
  it("runs the remote collectors under a locked server process", () => {
    const script = readFileSync(new URL("./collect-cycle.sh", import.meta.url), "utf8");

    expect(script).toContain("github-trend-radar-collector.lock");
    expect(script).toContain("credential fill");
    expect(script).toContain("read-collection-schedule.js");
    expect(script).toContain("collect-events-remote.js");
    expect(script).toContain("collect-remote.js");
    expect(script).not.toContain("sleep ");
  });

  it("checks the database schedule every five minutes", () => {
    const service = readFileSync(
      new URL("./systemd/github-trend-radar-collector.service", import.meta.url),
      "utf8",
    );
    const timer = readFileSync(
      new URL("./systemd/github-trend-radar-collector.timer", import.meta.url),
      "utf8",
    );

    expect(service).toContain("EnvironmentFile=/home/ubuntu/github-trend-radar/deploy/oracle/.env");
    expect(service).toContain("/home/ubuntu/github-trend-radar/deploy/oracle/collect-cycle.sh");
    expect(timer).toContain("OnCalendar=*:0/5");
    expect(timer).toContain("Persistent=true");
  });

  it("does not keep scheduled GitHub Actions collectors", () => {
    expect(existsSync(new URL("../../.github/workflows/collect.yml", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../../.github/workflows/collect-events.yml", import.meta.url))).toBe(false);
  });
});
