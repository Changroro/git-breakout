import { describe, expect, it } from "vitest";
import { localServiceStatus, parseServiceStatus } from "./service-status";

describe("service data freshness", () => {
  it("reports missing and stale data without claiming local event coverage", () => {
    const now = new Date("2026-09-12T12:00:00Z");
    expect(localServiceStatus(null, 120, now).status).toBe("degraded");
    const fresh = localServiceStatus("2026-09-12T10:00:00Z", 120, now);
    expect(fresh.status).toBe("ok");
    expect(fresh.snapshot_age_seconds).toBe(7200);
    expect(fresh.events).toEqual({ latest_completed_hour: null, missing_hours: null, source_complete: null });
    expect(localServiceStatus("2026-09-12T07:59:59Z", 120, now).status).toBe("degraded");
  });

  it("rejects inconsistent or malformed freshness responses", () => {
    const valid = localServiceStatus(null, 120, new Date("2026-09-12T12:00:00Z"));
    for (const change of [
      { snapshot_age_seconds: 0 }, { next_due_at: "invalid" }, { expected_interval_minutes: 0 },
      { events: { ...valid.events, source_complete: "true" } },
      { events: { ...valid.events, missing_hours: -1 } },
    ]) expect(() => parseServiceStatus({ ...valid, ...change })).toThrow();
  });
});
