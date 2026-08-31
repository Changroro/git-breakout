import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Oracle automatic deployment", () => {
  it("updates main before requiring files introduced by that revision", () => {
    const script = readFileSync(new URL("./auto-deploy.sh", import.meta.url), "utf8");

    expect(script).toContain("007_discovery_track_record.sql");
    expect(script.indexOf("test -f \"$migration_file\"")).toBeGreaterThan(
      script.indexOf("git -C \"$TREND_RADAR_REPO\" merge --ff-only"),
    );
  });
});
