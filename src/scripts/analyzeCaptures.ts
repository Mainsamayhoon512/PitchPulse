import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";

interface Capture {
  receivedAtMs: number;
  payload: any;
}

interface Msg {
  kind: "ball" | "snapshot";
  matchId: string;
  at: number; // when we received it (ms)
  providerAt: number; // the provider's own timestamp (ms)
  bytes: number;
  code: string;
  label: string;
  iid: string;
  over: string;
  ball: string;
  status: string;
}

// Ball events carry seconds, snapshots carry milliseconds. Normalise to ms.
const toMs = (ts: unknown): number => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n > 1e12 ? n : n * 1000;
};

function stats(label: string, values: number[], unit: string) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) {
    console.log(`${label}: no data`);
    return;
  }
  const at = (p: number) => v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
  console.log(
    `${label}: n=${v.length}  min=${Math.round(v[0])}${unit}  median=${Math.round(at(50))}${unit}  p90=${Math.round(at(90))}${unit}  max=${Math.round(v[v.length - 1])}${unit}`,
  );
}

const files = readdirSync(config.CAPTURE_DIR).filter((f) => f.endsWith(".ndjson")).sort();
if (files.length === 0) {
  console.error("No capture files found. Run: npm run listen");
  process.exit(1);
}
const file = process.argv[2] ?? join(config.CAPTURE_DIR, files[files.length - 1]);
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);

const msgs: Msg[] = [];
for (const line of lines) {
  const cap = JSON.parse(line) as Capture;
  const p = cap.payload;
  if (!p || typeof p !== "object") continue;

  if (p.api_type === "match_push_obj") {
    msgs.push({
      kind: "snapshot",
      matchId: String(p.response?.match_id),
      at: cap.receivedAtMs,
      providerAt: toMs(p.timestamp),
      bytes: line.length,
      code: "",
      label: "",
      iid: "",
      over: "",
      ball: "",
      status: String(p.response?.match_info?.status_str ?? "unknown"),
    });
  } else if (p.response?.ball_event !== undefined) {
    const d = p.response.data ?? {};
    msgs.push({
      kind: "ball",
      matchId: String(p.response.match_id),
      at: cap.receivedAtMs,
      providerAt: toMs(p.timestamp),
      bytes: line.length,
      code: String(p.response.code),
      label: String(p.response.ball_event),
      iid: String(d.iid),
      over: String(d.over),
      ball: String(d.ball),
      status: "",
    });
  }
}

if (msgs.length === 0) {
  console.error("No usable messages in the capture file.");
  process.exit(1);
}

const snapshots = msgs.filter((m) => m.kind === "snapshot");
const balls = msgs.filter((m) => m.kind === "ball");

// ---- 1. Overview ----
const seconds = Math.max(1, (msgs[msgs.length - 1].at - msgs[0].at) / 1000);
const totalBytes = msgs.reduce((sum, m) => sum + m.bytes, 0);
console.log(`File: ${file}`);
console.log(`Duration: ${(seconds / 60).toFixed(1)} min | messages: ${msgs.length} (${snapshots.length} snapshots, ${balls.length} ball events)`);
console.log(`Distinct matches: ${new Set(msgs.map((m) => m.matchId)).size}`);
console.log(`Total size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB | average: ${(totalBytes / 1024 / seconds).toFixed(0)} KB/s\n`);

// ---- 2. Snapshots by match status ----
console.log("== Snapshots by match status ==");
const byStatus = new Map<string, number>();
for (const s of snapshots) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
for (const [status, n] of byStatus) console.log(`${status}: ${n}`);

// ---- 3. Delay between the provider's timestamp and our receipt ----
// Depends on your PC clock being correct; ball timestamps only have 1-second precision.
console.log("\n== Provider timestamp -> received by us ==");
stats("Ball events", balls.map((m) => m.at - m.providerAt), "ms");
stats("Snapshots", snapshots.map((m) => m.at - m.providerAt), "ms");

// ---- 4. Ball event -> next snapshot of the same match ----
const pending = new Map<string, Msg[]>();
const lagAll: number[] = [];
const lagByCode = new Map<string, { label: string; lags: number[]; unmatched: number }>();
for (const m of msgs) {
  if (m.kind === "ball") {
    const list = pending.get(m.matchId) ?? [];
    list.push(m);
    pending.set(m.matchId, list);
    if (!lagByCode.has(m.code)) lagByCode.set(m.code, { label: m.label, lags: [], unmatched: 0 });
  } else {
    const list = pending.get(m.matchId);
    if (list) {
      for (const b of list) {
        const lag = m.at - b.at;
        lagAll.push(lag);
        lagByCode.get(b.code)!.lags.push(lag);
      }
      pending.delete(m.matchId);
    }
  }
}
for (const list of pending.values()) for (const b of list) lagByCode.get(b.code)!.unmatched++;

console.log("\n== Ball event -> next snapshot of the same match ==");
stats("All ball events", lagAll, "ms");
if (lagAll.length > 0) {
  const within3s = lagAll.filter((l) => l >= 0 && l <= 3000).length;
  console.log(`Followed by a snapshot within 3s: ${((within3s / lagAll.length) * 100).toFixed(0)}%`);
}
console.log("\ncode  label                          n    median-ms  p90-ms   no-snapshot-after");
const rows = [...lagByCode.entries()].sort(
  (a, b) => b[1].lags.length + b[1].unmatched - (a[1].lags.length + a[1].unmatched),
);
for (const [code, r] of rows) {
  const v = r.lags.sort((a, b) => a - b);
  const med = v.length ? Math.round(v[Math.floor(v.length / 2)]) : "-";
  const p90 = v.length ? Math.round(v[Math.min(v.length - 1, Math.floor(v.length * 0.9))]) : "-";
  console.log(
    `${code.padEnd(5)} ${r.label.slice(0, 28).padEnd(30)} ${String(v.length + r.unmatched).padEnd(4)} ${String(med).padEnd(10)} ${String(p90).padEnd(8)} ${r.unmatched}`,
  );
}

// ---- 5. How often snapshots arrive, and how big they are ----
console.log("\n== Snapshot cadence and size ==");
const lastSnap = new Map<string, number>();
const gaps: number[] = [];
for (const s of snapshots) {
  const prev = lastSnap.get(s.matchId);
  if (prev !== undefined) gaps.push(s.at - prev);
  lastSnap.set(s.matchId, s.at);
}
stats("Gap between snapshots of the same match", gaps, "ms");
stats("Snapshot size", snapshots.map((s) => s.bytes / 1024), "KB");

// ---- 6. Event sequences for the same delivery ----
const perBall = new Map<string, string[]>();
for (const b of balls) {
  const key = `${b.matchId}|${b.iid}|${b.over}|${b.ball}`;
  const arr = perBall.get(key) ?? [];
  arr.push(b.code);
  perBall.set(key, arr);
}
const patterns = new Map<string, number>();
let single = 0;
let multi = 0;
for (const codes of perBall.values()) {
  if (codes.length < 2) {
    single++;
    continue;
  }
  multi++;
  const p = codes.join(" -> ");
  patterns.set(p, (patterns.get(p) ?? 0) + 1);
}
console.log(`\n== Deliveries with one event: ${single}, with several events: ${multi} ==`);
console.log("Most common code sequences for the same delivery:");
for (const [p, n] of [...patterns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`${String(n).padEnd(5)} ${p}`);
}