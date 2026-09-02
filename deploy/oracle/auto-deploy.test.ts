import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Oracle automatic deployment", () => {
  it("updates main before requiring files introduced by that revision", () => {
    const script = readFileSync(new URL("./auto-deploy.sh", import.meta.url), "utf8");

    expect(script).toContain("009_github_trending_page.sql");
    expect(script.indexOf("test -f \"$migration_file\"")).toBeGreaterThan(
      script.indexOf("git -C \"$TREND_RADAR_REPO\" merge --ff-only"),
    );
  });

  it("loads the versioned deployment script after updating main", () => {
    const service = readFileSync(
      new URL("./systemd/github-trend-radar-deploy.service", import.meta.url),
      "utf8",
    );
    const fetchCommand = "fetch --prune origin refs/heads/main:refs/remotes/origin/main";
    const mergeCommand = "merge --ff-only refs/remotes/origin/main";
    const deployCommand = "/home/ubuntu/github-trend-radar/deploy/oracle/auto-deploy.sh";

    expect(service.indexOf(fetchCommand)).toBeGreaterThan(-1);
    expect(service.indexOf(mergeCommand)).toBeGreaterThan(service.indexOf(fetchCommand));
    expect(service.indexOf(deployCommand)).toBeGreaterThan(service.indexOf(mergeCommand));
    expect(service).not.toContain("/usr/local/sbin/github-trend-radar-deploy");
  });
});
