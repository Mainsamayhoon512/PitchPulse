import { readFileSync } from "node:fs";
import { config } from "../config";
import { prisma } from "../db";
import { LiveProcessor } from "../live/processor";
import { parseMessage } from "../live/parse";
import { ConsoleSink, createFirebaseSink, withCounts, type LiveSink } from "../live/sink";
import { redis } from "../redis";
import { sleep } from "../utils";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const opt = (f: string) => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// npm run replay -- [file] [--speed 20] [--limit 500] [--match 98955]
//                   [--archive] [--sink firebase] [--root replay] [--print]
const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "fixtures/live-sample.ndjson";
const speed = Number(opt("speed") ?? 20);
const limit = Number(opt("limit") ?? 0);
const only = opt("match");
const root = opt("root") ?? "replay"; // never overwrite real "live" data by accident

async function main() {
  let inner: LiveSink = new ConsoleSink(has("print"));
  if (opt("sink") === "firebase") {
    if (!config.FIREBASE_SERVICE_ACCOUNT || !config.FIREBASE_DATABASE_URL) {
      throw new Error("Set FIREBASE_SERVICE_ACCOUNT and FIREBASE_DATABASE_URL in .env first");
    }
    inner = createFirebaseSink(config.FIREBASE_SERVICE_ACCOUNT, config.FIREBASE_DATABASE_URL);
  }
  const { sink, counts } = withCounts(inner);
  const processor = new LiveProcessor(sink, { archive: has("archive"), root });

  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  console.log(`Replaying ${lines.length} messages from ${file} at ${speed}x into "${root}/" (archive: ${has("archive")})`);

  const started = Date.now();
  let prevMs: number | null = null;
  let sent = 0;
  let ignored = 0;

  for (const line of lines) {
    const cap = JSON.parse(line) as { receivedAtMs: number; payload: unknown };
    if (prevMs !== null) {
      const gap = Math.min(2000, Math.max(0, cap.receivedAtMs - prevMs)) / speed;
      if (gap >= 1) await sleep(gap);
    }
    prevMs = cap.receivedAtMs;

    const msg = parseMessage(JSON.stringify(cap.payload), Date.now());
    if (!msg) {
      ignored++;
      continue;
    }
    if (only && String(msg.matchId) !== only) continue;
    void processor.handle(msg);
    sent++;
    if (limit > 0 && sent >= limit) break;
  }
  await processor.drain();
  await processor.waitForSyncs(); // series syncs started in the background must finish before we close Postgres and Redis

  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s. Fed ${sent} messages (${ignored} unrecognised).`);
  console.log("Processor:", processor.stats);
  console.log("Sink:", counts);
  console.log("Latency (our side):", processor.latency.summary());
  if (has("archive")) {
    console.log("Postgres:", {
      balls: await prisma.ball.count(),
      innings: await prisma.innings.count(),
    });
  }
  await sink.close();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });