import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";

type Json = unknown;

// Prints the shape of a JSON value without its data (arrays show only the first item).
function outline(value: Json, depth: number, maxDepth: number): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.length} items, first: ${outline(value[0], depth + 1, maxDepth)}]`;
  }
  if (typeof value === "object") {
    if (depth >= maxDepth) return "{...}";
    const rows = Object.entries(value as Record<string, Json>).map(
      ([k, v]) => `${"  ".repeat(depth + 1)}${k}: ${outline(v, depth + 1, maxDepth)}`,
    );
    return `{\n${rows.join("\n")}\n${"  ".repeat(depth)}}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value.length > 40 ? value.slice(0, 40) + "…" : value);
  }
  return String(value);
}

interface Capture {
  receivedAtMs: number;
  receivedAt: string;
  parsed: boolean;
  payload: any;
}

const files = readdirSync(config.CAPTURE_DIR).filter((f) => f.endsWith(".ndjson")).sort();
if (files.length === 0) {
  console.error("No capture files found. Run: npm run listen");
  process.exit(1);
}
const file = process.argv[2] ?? join(config.CAPTURE_DIR, files[files.length - 1]);
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);

const kinds = new Map<string, number>();
const firstOfKind = new Map<string, Capture>();
const ballCodes = new Map<string, number>();
const smallSamples: string[] = [];

for (const line of lines) {
  const cap = JSON.parse(line) as Capture;
  const p = cap.payload;
  let kind = "unknown";
  if (p && typeof p === "object") {
    if (p.api_type) kind = String(p.api_type);
    else if (p.response?.ball_event !== undefined) kind = "ball_event";
  }
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  if (!firstOfKind.has(kind)) firstOfKind.set(kind, cap);

  if (kind === "ball_event") {
    const key = `${p.response.ball_event} (code ${p.response.code})`;
    ballCodes.set(key, (ballCodes.get(key) ?? 0) + 1);
  }
  if (line.length < 2500 && smallSamples.length < 8) {
    smallSamples.push(JSON.stringify(p));
  }
}

console.log(`File: ${file}`);
console.log(`Messages: ${lines.length}\n`);

console.log("== Message kinds ==");
for (const [kind, n] of kinds) console.log(`${kind}: ${n}`);

console.log("\n== Ball event types seen ==");
for (const [key, n] of ballCodes) console.log(`${key}: ${n}`);

console.log("\n== Small messages in full ==");
for (const s of smallSamples) console.log(s);

console.log("\n== Structure of the first message of each kind ==");
for (const [kind, cap] of firstOfKind) {
  console.log(`\n--- ${kind} ---`);
  console.log(outline(cap.payload, 0, 4));
}