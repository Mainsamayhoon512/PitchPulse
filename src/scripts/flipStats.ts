import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "fixtures/live-sample.ndjson";
const last = new Map<string, Record<string, unknown>>();
const perBall = new Map<string, number>();
const perField = new Map<string, number>();
let total = 0;

for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
  const p = JSON.parse(line).payload;
  if (p?.api_type !== "match_push_obj") continue;
  const res = p.response;
  const matchId = res?.match_id ?? res?.match_info?.match_id;
  for (const c of res?.live?.commentaries ?? []) {
    if (c.event !== "ball" && c.event !== "wicket") continue;
    const key = `${matchId}:${c.event_id}`;
    const { timestamp, ...rest } = c; // the timestamp moves on every snapshot, so skip it
    const prev = last.get(key);
    if (prev) {
      const changed = Object.keys(rest).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(rest[k]));
      if (changed.length > 0) {
        total++;
        perBall.set(key, (perBall.get(key) ?? 0) + 1);
        changed.forEach((k) => perField.set(k, (perField.get(k) ?? 0) + 1));
      }
    }
    last.set(key, rest);
  }
}

const byCount = new Map<number, number>();
for (const n of perBall.values()) byCount.set(n, (byCount.get(n) ?? 0) + 1);

console.log("total changes:", total);
console.log("balls changed at least once:", perBall.size, "of", last.size);
console.log("fields that changed:", Object.fromEntries([...perField].sort((a, b) => b[1] - a[1])));
console.log("times a ball changed -> number of balls:", Object.fromEntries([...byCount].sort((a, b) => a[0] - b[0])));
console.log("most-changed balls:", [...perBall].sort((a, b) => b[1] - a[1]).slice(0, 5));