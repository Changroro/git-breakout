import { describe, expect, it } from "vitest";
import { parseEventCollectorArguments } from "./event-collector.ts";

describe("parseEventCollectorArguments", () => {
  it("requires an exact hour and explicit candidate limit", () => {
    expect(parseEventCollectorArguments([
      "--hour=2026-08-28T10:00:00.000Z",
      "--limit=5000",
    ])).toEqual({
      bucketAt: "2026-08-28T10:00:00.000Z",
      candidateLimit: 5_000,
    });
  });

  it("rejects missing, unknown, and malformed arguments", () => {
    expect(() => parseEventCollectorArguments([])).toThrow("--hour");
    expect(() => parseEventCollectorArguments([
      "--hour=2026-08-28T10:00:00.000Z",
    ])).toThrow("--limit");
    expect(() => parseEventCollectorArguments([
      "--hour=2026-08-28T10:30:00.000Z",
      "--limit=5000",
    ])).toThrow("exact UTC hour");
    expect(() => parseEventCollectorArguments([
      "--hour=2026-08-28T10:00:00.000Z",
      "--limit=5000",
      "--extra=value",
    ])).toThrow("Unknown event collector argument");
  });
});
