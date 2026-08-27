export type RepositoryStarPoint = {
  captured_at: string;
  stars: number;
};

export type RepositoryStarSeries = {
  full_name: string;
  points: RepositoryStarPoint[];
};

export type StarSeriesResponse = {
  schema_version: "1.0";
  series: RepositoryStarSeries[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStarSeriesResponse(value: unknown): StarSeriesResponse {
  if (!isRecord(value) || value.schema_version !== "1.0" || !Array.isArray(value.series)) {
    throw new TypeError("Star series response does not match schema version 1.0");
  }
  const names = new Set<string>();
  value.series.forEach((series, seriesIndex) => {
    if (!isRecord(series) || typeof series.full_name !== "string" || !Array.isArray(series.points)) {
      throw new TypeError(`Star series ${seriesIndex} is invalid`);
    }
    const key = series.full_name.toLowerCase();
    if (!/^[^/\s]+\/[^/\s]+$/.test(series.full_name) || names.has(key)) {
      throw new TypeError(`Star series ${seriesIndex} repository is invalid`);
    }
    names.add(key);
    let previousTimestamp = Number.NEGATIVE_INFINITY;
    series.points.forEach((point, pointIndex) => {
      if (!isRecord(point)) {
        throw new TypeError(`Star series ${seriesIndex} point ${pointIndex} is invalid`);
      }
      const timestamp = typeof point.captured_at === "string"
        ? Date.parse(point.captured_at)
        : Number.NaN;
      if (
        !Number.isFinite(timestamp)
        || timestamp <= previousTimestamp
        || !Number.isInteger(point.stars)
        || (point.stars as number) < 0
      ) {
        throw new TypeError(`Star series ${seriesIndex} point ${pointIndex} is invalid`);
      }
      previousTimestamp = timestamp;
    });
  });
  return value as StarSeriesResponse;
}

export function buildSparklinePoints(
  points: readonly RepositoryStarPoint[],
  width: number,
  height: number,
  padding: number,
): string {
  if (points.length < 2) {
    throw new RangeError("A sparkline requires at least two observations");
  }
  if (width <= padding * 2 || height <= padding * 2 || padding < 0) {
    throw new RangeError("Sparkline dimensions are invalid");
  }
  const timestamps = points.map((point) => Date.parse(point.captured_at));
  const firstTimestamp = timestamps[0];
  const duration = timestamps[timestamps.length - 1] - firstTimestamp;
  if (duration <= 0) {
    throw new RangeError("Sparkline observations must span time");
  }
  const stars = points.map((point) => point.stars);
  const minimumStars = Math.min(...stars);
  const maximumStars = Math.max(...stars);
  const starRange = maximumStars - minimumStars;
  return points.map((point, index) => {
    const x = padding + ((timestamps[index] - firstTimestamp) / duration) * (width - padding * 2);
    const normalizedStars = starRange === 0 ? 0.5 : (point.stars - minimumStars) / starRange;
    const y = height - padding - normalizedStars * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}
