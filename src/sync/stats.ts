export type Stats = Record<string, number>;

export function bump(stats: Stats, key: string, n = 1): void {
  stats[key] = (stats[key] ?? 0) + n;
}

export function addStats(into: Stats, from: Stats, prefix = ""): void {
  for (const [key, value] of Object.entries(from)) bump(into, prefix + key, value);
}