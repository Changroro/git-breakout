export type ServiceStatus = {
  schema_version: "1.0";
  status: "ok" | "degraded";
  latest_snapshot_at: string | null;
  snapshot_age_seconds: number | null;
  expected_interval_minutes: number;
  next_due_at: string;
  last_failure: { at: string } | null;
  events: {
    latest_completed_hour: string | null;
    missing_hours: number | null;
    source_complete: boolean | null;
    excluded_invalid_names?: number;
  };
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Service status must contain objects");
  }
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Service status timestamp is invalid");
  }
  return value;
}

export function parseServiceStatus(value: unknown): ServiceStatus {
  const input = record(value);
  const events = record(input.events);
  if (input.schema_version !== "1.0" || (input.status !== "ok" && input.status !== "degraded")) {
    throw new TypeError("Service status version or state is invalid");
  }
  if (!Number.isInteger(input.expected_interval_minutes) || (input.expected_interval_minutes as number) <= 0) {
    throw new TypeError("Service collection interval must be positive");
  }
  if (input.snapshot_age_seconds !== null && (typeof input.snapshot_age_seconds !== "number"
    || !Number.isFinite(input.snapshot_age_seconds) || input.snapshot_age_seconds < 0)) {
    throw new TypeError("Snapshot age must be nonnegative or unknown");
  }
  if ((input.latest_snapshot_at === null) !== (input.snapshot_age_seconds === null)) {
    throw new TypeError("Snapshot time and age must agree");
  }
  if (events.missing_hours !== null && (!Number.isInteger(events.missing_hours) || (events.missing_hours as number) < 0)) {
    throw new TypeError("Missing event hours must be nonnegative or unknown");
  }
  if (events.source_complete !== null && typeof events.source_complete !== "boolean") {
    throw new TypeError("Event completeness must be boolean or unknown");
  }
  if (events.excluded_invalid_names !== undefined && (!Number.isInteger(events.excluded_invalid_names)
    || (events.excluded_invalid_names as number) < 0)) throw new TypeError("Excluded event names must be a nonnegative count");
  return {
    schema_version: "1.0", status: input.status,
    latest_snapshot_at: input.latest_snapshot_at === null ? null : timestamp(input.latest_snapshot_at),
    snapshot_age_seconds: input.snapshot_age_seconds as number | null,
    expected_interval_minutes: input.expected_interval_minutes as number,
    next_due_at: timestamp(input.next_due_at),
    last_failure: input.last_failure === null ? null : { at: timestamp(record(input.last_failure).at) },
    events: {
      latest_completed_hour: events.latest_completed_hour === null ? null : timestamp(events.latest_completed_hour),
      missing_hours: events.missing_hours as number | null,
      source_complete: events.source_complete as boolean | null,
      ...(events.excluded_invalid_names === undefined ? {} : { excluded_invalid_names: events.excluded_invalid_names as number }),
    },
  };
}

export function localServiceStatus(latestSnapshotAt: string | null, intervalMinutes: number, now = new Date()): ServiceStatus {
  const latest = latestSnapshotAt === null ? null : Date.parse(timestamp(latestSnapshotAt));
  const age = latest === null ? null : Math.max(0, (now.getTime() - latest) / 1000);
  return parseServiceStatus({
    schema_version: "1.0",
    status: age === null || age > intervalMinutes * 120 ? "degraded" : "ok",
    latest_snapshot_at: latestSnapshotAt, snapshot_age_seconds: age,
    expected_interval_minutes: intervalMinutes,
    next_due_at: new Date(latest === null ? now.getTime() : latest + intervalMinutes * 60_000).toISOString(),
    last_failure: null,
    events: { latest_completed_hour: null, missing_hours: null, source_complete: null },
  });
}
