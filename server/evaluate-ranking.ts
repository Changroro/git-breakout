import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { evaluateRankings, parseRankingEvaluationInput } from "../src/lib/ranking-evaluation.ts";

const [inputPath, topKArgument = "20", ...extra] = process.argv.slice(2);
if (inputPath === undefined || extra.length > 0 || !/^\d+$/.test(topKArgument)) {
  throw new Error("Usage: npm run evaluate:ranking -- snapshot-history.json [top-k: 1–100]");
}
const bytes = readFileSync(inputPath);
const input = parseRankingEvaluationInput(JSON.parse(bytes.toString("utf8")));
const report = evaluateRankings(input, Number(topKArgument));
process.stdout.write(JSON.stringify({
  ...report, input_sha256: createHash("sha256").update(bytes).digest("hex"),
}, null, 2) + "\n");
