type EvaluationScore = { score: number | null; components: Record<string, number | null> };
type EvaluationTrend = {
  score_version: string;
  confidence: "low" | "medium" | "high";
  missing_evidence: string[];
  breakout: EvaluationScore;
  resurgence?: EvaluationScore;
  current_heat: EvaluationScore;
};
type EvaluationRepository = {
  repository_id?: string;
  full_name: string;
  metrics: { stars: number | null };
  momentum: { score: number; score_version: "baseline-v1" };
  trend_intelligence?: EvaluationTrend;
};
export type EvaluationSnapshot = {
  id: string;
  captured_at: string;
  repositories: EvaluationRepository[];
};
export type RankingEvaluationInput = { schema_version: "1.0"; snapshots: EvaluationSnapshot[] };
type RankedSelection = { repository: EvaluationRepository; score: number };
type EvaluationView = "breakout" | "resurgence" | "current_heat";
const HOUR_MS = 3_600_000;
const VIEWS: EvaluationView[] = ["breakout", "resurgence", "current_heat"];

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field} is required`);
  return value;
}

function nullableNumber(value: unknown, field: string, maximum = Infinity): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new TypeError(`${field} must be null or a finite number from 0 to ${maximum}`);
  }
  return value;
}

function parseScore(value: unknown, field: string): EvaluationScore {
  const score = record(value, field);
  const components = record(score.components, `${field}.components`);
  return {
    score: nullableNumber(score.score, `${field}.score`, 100),
    components: Object.fromEntries(Object.entries(components).map(([key, component]) => [
      key, nullableNumber(component, `${field}.components.${key}`, 1),
    ])),
  };
}

export function parseRankingEvaluationInput(value: unknown): RankingEvaluationInput {
  const input = record(value, "input");
  if (input.schema_version !== "1.0" || !Array.isArray(input.snapshots) || input.snapshots.length === 0) {
    throw new TypeError("Evaluation requires schema_version 1.0 and non-empty snapshots");
  }
  const ids = new Set<string>();
  let previousTime = -Infinity;
  const snapshots = input.snapshots.map((value, index): EvaluationSnapshot => {
    const snapshot = record(value, `snapshot ${index}`);
    const id = text(snapshot.id, "snapshot.id");
    const capturedAt = text(snapshot.captured_at, "snapshot.captured_at");
    const time = Date.parse(capturedAt);
    if (!Number.isFinite(time) || time <= previousTime || ids.has(id)) {
      throw new TypeError("Snapshot timestamps must increase strictly and ids must be unique");
    }
    previousTime = time;
    ids.add(id);
    if (!Array.isArray(snapshot.repositories)) throw new TypeError("snapshot.repositories must be an array");
    const names = new Set<string>();
    const repositoryIds = new Set<string>();
    const repositories = snapshot.repositories.map((value): EvaluationRepository => {
      const row = record(value, "repository");
      const name = text(row.full_name, "repository.full_name");
      if (!/^[^/\s]+\/[^/\s]+$/.test(name) || names.has(name.toLowerCase())) {
        throw new TypeError("Repository names must be unique owner/name values within each snapshot");
      }
      names.add(name.toLowerCase());
      const repositoryId = row.repository_id === undefined ? undefined : text(row.repository_id, `${name}.repository_id`);
      if (repositoryId !== undefined) {
        if (repositoryIds.has(repositoryId)) throw new TypeError("Repository ids must be unique within each snapshot");
        repositoryIds.add(repositoryId);
      }
      const metrics = record(row.metrics, `${name}.metrics`);
      const stars = nullableNumber(metrics.stars, `${name}.stars`);
      if (stars !== null && !Number.isSafeInteger(stars)) throw new TypeError("Stars must be a safe integer");
      const momentum = record(row.momentum, `${name}.momentum`);
      const score = nullableNumber(momentum.score, `${name}.momentum.score`);
      if (score === null || momentum.score_version !== "baseline-v1") {
        throw new TypeError("Evaluation requires a stored baseline-v1 score for every repository");
      }
      const repository: EvaluationRepository = {
        full_name: name, metrics: { stars }, momentum: { score, score_version: "baseline-v1" },
        ...(repositoryId === undefined ? {} : { repository_id: repositoryId }),
      };
      if (row.trend_intelligence !== undefined) {
        const trend = record(row.trend_intelligence, `${name}.trend_intelligence`);
        const version = text(trend.score_version, `${name}.score_version`);
        if (!["low", "medium", "high"].includes(trend.confidence as string)
          || !Array.isArray(trend.missing_evidence)
          || trend.missing_evidence.some(item => typeof item !== "string")) {
          throw new TypeError("Trend confidence and missing_evidence are required");
        }
        repository.trend_intelligence = {
          score_version: version,
          confidence: trend.confidence as EvaluationTrend["confidence"],
          missing_evidence: [...trend.missing_evidence] as string[],
          breakout: parseScore(trend.breakout, `${name}.breakout`),
          current_heat: parseScore(trend.current_heat, `${name}.current_heat`),
          ...(trend.resurgence === undefined ? {} : { resurgence: parseScore(trend.resurgence, `${name}.resurgence`) }),
        };
      }
      return repository;
    });
    return { id, captured_at: capturedAt, repositories };
  });
  return { schema_version: "1.0", snapshots };
}

function ordered(rows: RankedSelection[]): RankedSelection[] {
  return rows.sort((left, right) => right.score - left.score
    || (left.repository.full_name.toLowerCase() < right.repository.full_name.toLowerCase() ? -1 : 1));
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function outcome(
  repository: EvaluationRepository,
  origin: EvaluationSnapshot,
  snapshots: EvaluationSnapshot[],
  horizonHours: number,
  toleranceHours: number,
) {
  const start = Date.parse(origin.captured_at);
  const target = start + horizonHours * HOUR_MS;
  const deadline = target + toleranceHours * HOUR_MS;
  const base = { full_name: repository.full_name, start_stars: repository.metrics.stars };
  const lastTime = Date.parse(snapshots.at(-1)!.captured_at);
  if (repository.metrics.stars === null) {
    return { ...base, status: "missing_start" as const, delta_stars: null, stars_per_day: null };
  }
  for (const snapshot of snapshots) {
    const time = Date.parse(snapshot.captured_at);
    if (time < target) continue;
    if (time > deadline) break;
    const verified = repository.repository_id === undefined ? undefined
      : snapshot.repositories.find(row => row.repository_id === repository.repository_id);
    const future = verified ?? snapshot.repositories.find(row =>
      (repository.repository_id === undefined || row.repository_id === undefined)
      && row.full_name.toLowerCase() === repository.full_name.toLowerCase());
    if (future === undefined || future.metrics.stars === null) continue;
    const delta = future.metrics.stars - repository.metrics.stars;
    const elapsedHours = (time - start) / HOUR_MS;
    return {
      ...base, status: "observed" as const, observed_at: snapshot.captured_at,
      observed_full_name: future.full_name,
      identity_basis: repository.repository_id !== undefined && future.repository_id !== undefined
        ? "repository_id" as const : "name_unverified" as const,
      elapsed_hours: elapsedHours, delta_stars: delta, stars_per_day: delta * 24 / elapsedHours,
    };
  }
  return {
    ...base, status: lastTime < deadline ? "pending" as const : "missing" as const,
    delta_stars: null, stars_per_day: null,
  };
}

function summarize(rows: ReturnType<typeof outcome>[]) {
  const observed = rows.filter(row => row.status === "observed");
  return {
    selected: rows.length, observed: observed.length,
    pending: rows.filter(row => row.status === "pending").length,
    missing: rows.filter(row => row.status === "missing" || row.status === "missing_start").length,
    coverage: rows.length === 0 ? null : observed.length / rows.length,
    verified_identity_observations: observed.filter(row => row.identity_basis === "repository_id").length,
    unverified_identity_observations: observed.filter(row => row.identity_basis === "name_unverified").length,
    mean_delta_stars: mean(observed.map(row => row.delta_stars!)),
    mean_stars_per_day: mean(observed.map(row => row.stars_per_day!)),
    positive_growth_rate: observed.length === 0 ? null : observed.filter(row => row.delta_stars! > 0).length / observed.length,
  };
}

function summarizeStrata(selection: RankedSelection[], outcomes: ReturnType<typeof outcome>[]) {
  const strata = new Map<string, ReturnType<typeof outcome>[]>();
  selection.forEach(({ repository }, index) => {
    const trend = repository.trend_intelligence;
    const stars = repository.metrics.stars;
    const groups = [
      `stars:${stars === null ? "unknown" : stars < 1_000 ? "under_1000" : stars < 10_000 ? "1000_to_9999" : "10000_plus"}`,
      `confidence:${trend?.confidence ?? "unknown"}`,
      `evidence:${trend === undefined ? "unknown" : trend.missing_evidence.length === 0 ? "complete" : "partial"}`,
    ];
    for (const group of groups) strata.set(group, [...(strata.get(group) ?? []), outcomes[index]]);
  });
  return Object.fromEntries([...strata].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rows]) => [key, summarize(rows)]));
}

function componentAblations(pool: RankedSelection[], view: EvaluationView, topK: number) {
  const originalOrder = ordered([...pool]);
  const originalTop = new Set(originalOrder.slice(0, topK).map(row => row.repository.full_name));
  const components = new Set(pool.flatMap(row => Object.keys(row.repository.trend_intelligence![view]!.components)));
  return [...components].sort().map(component => {
    const masked = ordered(pool.flatMap(row => {
      const scoreComponents = row.repository.trend_intelligence![view]!.components;
      const values = Object.entries(scoreComponents)
        .filter(([key, value]) => key !== component && value !== null).map(([, value]) => value!);
      const score = mean(values);
      return score === null ? [] : [{ repository: row.repository, score: 100 * score }];
    }));
    const maskedTop = masked.slice(0, topK).map(row => row.repository.full_name);
    return {
      masked_component: component,
      affected_candidates: pool.filter(row => row.repository.trend_intelligence![view]!.components[component] != null).length,
      unscoreable_after_mask: pool.length - masked.length,
      top_k: maskedTop,
      retained_top_k: maskedTop.filter(name => originalTop.has(name)).length,
      rank_changes: originalOrder.map((row, index) => ({
        full_name: row.repository.full_name, original_rank: index + 1,
        masked_rank: masked.findIndex(item => item.repository.full_name === row.repository.full_name) + 1 || null,
      })),
    };
  });
}

export function evaluateRankings(input: RankingEvaluationInput, topK = 20, toleranceHours = 3) {
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 100) throw new RangeError("topK must be 1–100");
  if (!Number.isFinite(toleranceHours) || toleranceHours < 0 || toleranceHours > 24) {
    throw new RangeError("toleranceHours must be 0–24");
  }
  const { snapshots } = parseRankingEvaluationInput(input);
  const evaluations = snapshots.flatMap(snapshot => {
    const versions = [...new Set(snapshot.repositories.flatMap(row => row.trend_intelligence === undefined
      ? [] : [row.trend_intelligence.score_version]))].sort();
    return versions.flatMap(version => VIEWS.map(view => {
      const pool = snapshot.repositories.flatMap(repository => {
        const trend = repository.trend_intelligence;
        const score = trend?.[view]?.score;
        return trend?.score_version === version && score !== undefined && score !== null ? [{ repository, score }] : [];
      });
      const selected = ordered([...pool]).slice(0, topK);
      const baseline = ordered(pool.map(row => ({ repository: row.repository, score: row.repository.momentum.score }))).slice(0, topK);
      return {
        snapshot_id: snapshot.id, captured_at: snapshot.captured_at, score_version: version, view,
        candidate_count: snapshot.repositories.length, scoreable_count: pool.length,
        scoreable_coverage: snapshot.repositories.length === 0 ? null : pool.length / snapshot.repositories.length,
        selected: selected.map(row => ({ full_name: row.repository.full_name, score: row.score })),
        baseline: baseline.map(row => ({ full_name: row.repository.full_name, score: row.score })),
        horizons: [24, 72].map(hours => {
          const evaluateSelection = (rows: RankedSelection[]) => {
            const outcomes = rows.map(row => outcome(row.repository, snapshot, snapshots, hours, toleranceHours));
            return { ...summarize(outcomes), strata: summarizeStrata(rows, outcomes), outcomes };
          };
          return { hours, model: evaluateSelection(selected), baseline: evaluateSelection(baseline) };
        }),
        component_ablations: componentAblations(pool, view, topK),
      };
    }).filter(evaluation => evaluation.scoreable_count > 0));
  });
  return {
    schema_version: "1.0", evaluation_version: "offline-ranking-v1",
    top_k: topK, horizons_hours: [24, 72], tolerance_hours: toleranceHours,
    dataset: { snapshots: snapshots.length, first_at: snapshots[0].captured_at, last_at: snapshots.at(-1)!.captured_at },
    baseline_scope: "The same scoreable candidates from the same origin snapshot and score version.",
    limitations: [
      "Stored origin scores and eligibility are frozen; later snapshots supply only observed total-star outcomes.",
      "Observational growth is not causal usefulness, organic attention, or a guarantee of future performance.",
      "Component ablation drops one saved normalized component and averages the remainder in a fixed eligible pool; it does not replay cohort percentiles, classification, or production display gates.",
      "Missing follow-up observations are not zero growth. Stable ids match follow-ups when supplied; name-only matches are labeled unverified and conflicting ids never match.",
      "No empirical quality conclusion follows from synthetic fixtures or a small, selectively supplied dataset.",
    ],
    evaluations,
  };
}
