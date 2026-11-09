import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";

interface Version {
  eventId: string;
  score: string;
  detail: string;
  isExtra: boolean; // a wide or no-ball (these legitimately repeat the same over and ball)
}

const files = readdirSync(config.CAPTURE_DIR).filter((f) => f.endsWith(".ndjson")).sort();
const file = process.argv[2] ?? join(config.CAPTURE_DIR, files[files.length - 1]);
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);

// One entry per delivery (match + innings + over + ball), holding every distinct version seen.
const deliveries = new Map<string, Version[]>();

for (const line of lines) {
  const p = JSON.parse(line).payload;
  if (p?.api_type !== "match_push_obj") continue;
  const r = p.response;
  const iid = String(r.live?.live_inning?.iid ?? "");
  for (const c of r.live?.commentaries ?? []) {
    if (c.event !== "ball" && c.event !== "wicket") continue;
    const key = `${r.match_id}|${iid}|${c.over}|${c.ball}`;
    const v: Version = {
      eventId: String(c.event_id),
      score: String(c.score),
      detail: `bat${c.bat_run} wd${c.wide_run} nb${c.noball_run} b${c.bye_run} lb${c.legbye_run}`,
      isExtra: c.wide_run !== "0" || c.noball_run !== "0",
    };
    const list = deliveries.get(key) ?? [];
    const known = list.some(
      (x) => x.eventId === v.eventId && x.score === v.score && x.detail === v.detail,
    );
    if (!known) {
      list.push(v);
      deliveries.set(key, list);
    }
  }
}

const show = (list: Version[]) =>
  list.map((v) => `[id ${v.eventId}: ${v.score} ${v.detail}]`).join(" -> ");

let unchanged = 0;
let rebowls = 0;
let inPlaceCount = 0;
let replacedCount = 0;
const inPlace: string[] = [];
const replaced: string[] = [];

for (const [key, list] of deliveries) {
  if (list.length === 1) {
    unchanged++;
    continue;
  }
  const ids = new Set(list.map((v) => v.eventId));
  if (ids.size < list.length) {
    inPlaceCount++; // same event_id, different content
    if (inPlace.length < 8) inPlace.push(`${key}  ${show(list)}`);
  } else if (list.some((v) => v.isExtra)) {
    rebowls++; // normal: a wide or no-ball means the ball is bowled again
  } else {
    replacedCount++; // different event_ids for the same delivery, no extras involved
    if (replaced.length < 8) replaced.push(`${key}  ${show(list)}`);
  }
}

console.log(`File: ${file}`);
console.log(`Deliveries seen in snapshots: ${deliveries.size}`);
console.log(`Never changed: ${unchanged}`);
console.log(`Normal re-bowls (wide or no-ball): ${rebowls}`);
console.log(`Corrected IN PLACE (same event_id, new content): ${inPlaceCount}`);
for (const s of inPlace) console.log("  " + s);
console.log(`Replaced by a NEW event_id (no wide/no-ball involved): ${replacedCount}`);
for (const s of replaced) console.log("  " + s);