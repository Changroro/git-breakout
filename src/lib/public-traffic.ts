export type PublicTrafficResponse = {
  schema_version: "1.0";
  date: string;
  time_zone: "Asia/Seoul";
  visits: number;
  generated_at: string;
};

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireIsoTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO timestamp`);
  }
  return value;
}

export function parsePublicTrafficResponse(value: unknown): PublicTrafficResponse {
  const record = requireRecord(value, "Public traffic response");
  if (record.schema_version !== "1.0") {
    throw new TypeError("Public traffic schema_version must be 1.0");
  }
  if (typeof record.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) {
    throw new TypeError("Public traffic date must be YYYY-MM-DD");
  }
  if (record.time_zone !== "Asia/Seoul") {
    throw new TypeError("Public traffic time_zone must be Asia/Seoul");
  }
  if (!Number.isSafeInteger(record.visits) || (record.visits as number) < 0) {
    throw new TypeError("Public traffic visits must be a non-negative integer");
  }
  return {
    schema_version: "1.0",
    date: record.date,
    time_zone: "Asia/Seoul",
    visits: record.visits as number,
    generated_at: requireIsoTimestamp(record.generated_at, "Public traffic generated_at"),
  };
}
