export type EventCollectorArguments = {
  bucketAt: string;
  candidateLimit: number;
};

function exactUtcHour(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    && parsed.getUTCMinutes() === 0
    && parsed.getUTCSeconds() === 0
    && parsed.getUTCMilliseconds() === 0
    && parsed.toISOString() === value;
}

export function parseEventCollectorArguments(args: readonly string[]): EventCollectorArguments {
  const values = new Map<string, string>();
  args.forEach((argument) => {
    const match = /^--([a-z]+)=(.+)$/.exec(argument);
    if (match === null || !["hour", "limit"].includes(match[1])) {
      throw new TypeError(`Unknown event collector argument ${argument}`);
    }
    if (values.has(match[1])) {
      throw new TypeError(`Duplicate event collector argument --${match[1]}`);
    }
    values.set(match[1], match[2]);
  });
  const bucketAt = values.get("hour");
  if (bucketAt === undefined) {
    throw new TypeError("Event collector requires --hour");
  }
  if (!exactUtcHour(bucketAt)) {
    throw new TypeError("Event collector --hour must be an exact UTC hour in ISO-8601 format");
  }
  const limitValue = values.get("limit");
  if (limitValue === undefined) {
    throw new TypeError("Event collector requires --limit");
  }
  const candidateLimit = Number(limitValue);
  if (!Number.isInteger(candidateLimit) || candidateLimit <= 0) {
    throw new RangeError("Event collector --limit must be a positive integer");
  }
  return { bucketAt, candidateLimit };
}
