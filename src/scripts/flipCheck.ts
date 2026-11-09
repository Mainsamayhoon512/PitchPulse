import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "fixtures/live-sample.ndjson";
const matchId = Number(process.argv[3] ?? 98955);
const eventId = String(process.argv[4] ?? 15415644);

let last = "";
let shownKeys = false;
for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
  const cap = JSON.parse(line);
  const p = cap.payload;
  if (p?.api_type !== "match_push_obj") continue;
  const res = p.response;
  if (Number(res?.match_id ?? res?.match_info?.match_id) !== matchId) continue;
  const live = res.live ?? {};
  const c = (live.commentaries ?? []).find((x: any) => String(x.event_id) === eventId);
  if (!c) continue;
  const batsmen: any[] = live.batsmen ?? [];
  if (!shownKeys && batsmen[0]) {
    console.log("batsmen fields:", Object.keys(batsmen[0]).join(", "));
    shownKeys = true;
  }
  const flags = batsmen
    .map((b) => {
      const f = Object.entries(b).filter(([k]) => /strike|facing/i.test(k) && !/rate/i.test(k));
      return `${b.name}(${b.batsman_id}) ${JSON.stringify(Object.fromEntries(f))}`;
    })
    .join(" ; ");
  const row = `ball batsman_id=${c.batsman_id} "${String(c.commentary).slice(0, 45)}" | live: ${flags}`;
  if (row !== last) {
    console.log(new Date(cap.receivedAtMs).toISOString().slice(11, 19), row);
    last = row;
  }
}