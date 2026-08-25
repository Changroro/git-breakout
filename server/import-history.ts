import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HistoryDatabase } from "./history.ts";
import type { RepositoryCandidate } from "../src/lib/ranking.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const inputPath = process.argv[2];
if (inputPath === undefined) {
  throw new TypeError("Usage: npm run history:import -- <snapshot.json>");
}

const input = JSON.parse(readFileSync(resolve(inputPath), "utf8")) as unknown;
if (!isRecord(input) || !isRecord(input.run) || !Array.isArray(input.repositories)) {
  throw new TypeError("Snapshot JSON must contain run and repositories");
}
if (input.run.status !== "completed") {
  throw new TypeError("Only completed runs can be imported");
}
if (
  typeof input.run.id !== "string" ||
  typeof input.run.completed_at !== "string" ||
  !Array.isArray(input.run.sources) ||
  !input.run.sources.every((source) => typeof source === "string")
) {
  throw new TypeError("Run id, completed_at, and sources are required");
}
input.repositories.forEach((repository, index) => {
  if (!isRecord(repository) || typeof repository.full_name !== "string") {
    throw new TypeError(`Repository ${index} is invalid`);
  }
});

const database = new HistoryDatabase(resolve(process.cwd(), "data", "ranking-history.sqlite"));
try {
  database.appendSnapshot({
    id: input.run.id,
    capturedAt: input.run.completed_at,
    source: input.run.sources.join(","),
    repositories: input.repositories as RepositoryCandidate[],
  });
  process.stdout.write(`Imported ${input.run.id}\n`);
} finally {
  database.close();
}
