import { describe, expect, it } from "vitest";
import { parsePublicTrafficResponse } from "./public-traffic";

describe("parsePublicTrafficResponse", () => {
  it("parses a valid KST daily visit count", () => {
    expect(parsePublicTrafficResponse({
      schema_version: "1.0",
      date: "2026-09-01",
      time_zone: "Asia/Seoul",
      visits: 15,
      generated_at: "2026-09-01T03:15:00.000Z",
    })).toMatchObject({ visits: 15 });
  });

  it("rejects malformed counts and time zones", () => {
    expect(() => parsePublicTrafficResponse({
      schema_version: "1.0",
      date: "2026-09-01",
      time_zone: "UTC",
      visits: -1,
      generated_at: "2026-09-01T03:15:00.000Z",
    })).toThrow("time_zone");
  });
});
