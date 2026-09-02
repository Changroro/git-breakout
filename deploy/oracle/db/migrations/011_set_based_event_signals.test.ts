import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("set-based event signal migration", () => {
  it("aggregates candidate windows without per-repository function calls", () => {
    const migration = readFileSync(
      new URL("./011_set_based_event_signals.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("create or replace function api.event_signal_context()");
    expect(migration).toContain("candidate_counts as materialized");
    expect(migration).toContain("window_totals as");
    expect(migration).toContain("window_actors as");
    expect(migration).toContain("window_totals as materialized");
    expect(migration).toContain("window_actors as materialized");
    expect(migration).not.toContain("radar.repository_event_window(");
  });

  it("matches the function installed by the base schema", () => {
    const migration = readFileSync(
      new URL("./011_set_based_event_signals.sql", import.meta.url),
      "utf8",
    );
    const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
    const pattern = /create(?: or replace)? function api\.event_signal_context\(\)[\s\S]*?\n\$\$;/;
    const migrationFunction = migration.match(pattern)?.[0]
      .replace("create or replace function", "create function");
    const schemaFunction = schema.match(pattern)?.[0];

    expect(migrationFunction).toBeDefined();
    expect(schemaFunction).toBe(migrationFunction);
  });
});
