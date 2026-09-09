export function percentileRanks(population: readonly number[]): ReadonlyMap<number, number> {
  const ranks = new Map<number, number>();
  if (population.length < 2) return ranks;
  const sorted = [...population].sort((left, right) => left - right);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end] === sorted[start]) end += 1;
    ranks.set(sorted[start], (start + (end - start - 1) / 2) / (sorted.length - 1));
    start = end;
  }
  return ranks;
}
