import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("archive page migration", () => {
  it("derives inactive repositories without deleting snapshot history", () => {
    const migration = readFileSync(new URL("./008_archive_page.sql", import.meta.url), "utf8");

    expect(migration).toContain("create or replace function api.archive_page");
    expect(migration).toContain("current_rows.snapshot_id = latest_snapshot.id");
    expect(migration).toContain("order by matching.captured_at desc, matching.full_name_key");
    expect(migration).not.toMatch(/delete\s+from\s+radar\.snapshot_repositories/i);
    expect(migration).toContain("grant execute on function api.archive_page(integer, integer, text)");
  });
});
