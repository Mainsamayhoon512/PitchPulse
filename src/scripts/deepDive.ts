import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";

// Prints the shape of a JSON value, not its data.
function outline(value: any, depth: number, maxDepth: number): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.length} items, first: ${outline(value[0], depth + 1, maxDepth)}]`;
  }
  if (typeof value === "object") {
    if (depth >= maxDepth) return "{...}";
    const pad = "  ".repeat(depth + 1);
    const rows = Object.entries(value).map(([k, v]) => `${pad}${k}: ${outline(v, depth + 1, maxDepth)}`);
    return `{\n${rows.join("\n")}\n${"  ".repeat(depth)}}`;
  }
  if (typeof value === "string") return JSON.stringify(value.length > 50 ? value.slice(0, 50) + "…" : value);
  return String(value);
}

const files = readdirSync(config.CAPTURE_DIR).filter((f) => f.endsWith(".ndjson")).sort();
const file = process.argv[2] ?? join(config.CAPTURE_DIR, files[files.length - 1]);
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);

const enums: Record<string, Map<string, number>> = {};
const bump = (group: string, key: string) => {
  const m = (enums[group] ??= new Map());
  m.set(key, (m.get(key) ?? 0) + 1);
};

const samples: Record<string, any> = {};
const matchEnded = new Set<string>();
const afterEnd = new Map<string, string[]>();
const pending = new Map<string, any[]>();
let mappingShown = 0;

for (const line of lines) {
  const p = JSON.parse(line).payload;
  if (!p || typeof p !== "object") continue;

  // ---- ball events ----
  if (p.response?.ball_event !== undefined) {
    const r = p.response;
    const matchId = String(r.match_id);
    if (r.code === "67") matchEnded.add(matchId);
    if (["26", "35", "31", "32"].includes(String(r.code)) && mappingShown < 6) {
      const list = pending.get(matchId) ?? [];
      list.push({ label: r.ball_event, over: r.data?.over, ball: r.data?.ball, inn: r.data?.inn_num });
      pending.set(matchId, list);
    }
    continue;
  }

  // ---- snapshots ----
  if (p.api_type !== "match_push_obj") continue;
  const r = p.response;
  const mi = r.match_info ?? {};
  const matchId = String(r.match_id);

  bump("format", `${mi.format} = ${mi.format_str}`);
  bump("match status", `${mi.status} = ${mi.status_str}`);
  bump("game_state", `${mi.game_state} = ${mi.game_state_str}`);
  bump("result_type", `${JSON.stringify(mi.result_type)} (result: ${String(mi.result).slice(0, 25)})`);
  bump("toss decision", `${mi.toss?.decision}`);
  for (const inn of r.scorecard?.innings ?? []) {
    bump("innings status", `${inn.status}`);
    bump("innings result", `${inn.result}`);
  }

  if (matchEnded.has(matchId)) {
    const arr = afterEnd.get(matchId) ?? [];
    if (arr.length < 5) arr.push(`${mi.status_str}/${mi.game_state_str}`);
    afterEnd.set(matchId, arr);
  }

  const comms: any[] = r.live?.commentaries ?? [];
  const ballsOnly = comms.filter((c) => c.event === "ball" || c.event === "wicket");
  const waiting = pending.get(matchId);
  if (waiting && mappingShown < 6) {
    const tail = ballsOnly.slice(-3).map((c) => `over ${c.over} ball ${c.ball} score ${c.score} event_id ${c.event_id}`);
    for (const ev of waiting) {
      if (mappingShown++ >= 6) break;
      console.log(`MAPPING  event "${ev.label}" over ${ev.over} ball ${ev.ball} inn ${ev.inn}\n         latest balls in next snapshot: ${tail.join(" | ")}`);
    }
    pending.delete(matchId);
  }

  for (const c of comms) {
    if (c.event === "wicket") samples.wicket ??= c;
    else if (c.event === "overend") samples.overend ??= c;
    else if (c.event === "ball") {
      samples.ball ??= c;
      if (c.noball_run !== "0" || c.wide_run !== "0") samples.extra ??= c;
    }
  }
  samples.liveBatsman ??= r.live?.batsmen?.[0];
  samples.liveBowler ??= r.live?.bowlers?.[0];
  samples.liveInning ??= r.live?.live_inning;
  samples.scorecardInning ??= r.scorecard?.innings?.[0];
  samples.squadEntry ??= r["match-playing11"]?.teama?.squads?.[0];
  samples.matchNotes ??= r.match_notes?.[0];
}

console.log("\n== CODE TABLES (value = count) ==");
for (const [group, m] of Object.entries(enums)) {
  console.log(`\n${group}:`);
  for (const [k, n] of [...m.entries()].sort()) console.log(`  ${k}  (${n})`);
}

console.log("\n== AFTER 'Match End': next snapshot statuses per match ==");
if (afterEnd.size === 0) console.log("No snapshots arrived after a Match End.");
for (const [id, arr] of afterEnd) console.log(`match ${id}: ${arr.join(", ")}`);

console.log("\n== STRUCTURES (first example of each) ==");
for (const [name, value] of Object.entries(samples)) {
  console.log(`\n--- ${name} ---`);
  console.log(outline(value, 0, 3));
}