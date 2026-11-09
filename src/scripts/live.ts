import { existsSync } from "node:fs";
import { config } from "../config";
import { prisma } from "../db";
import { cleanupFinished } from "../live/cleanup";
import { Feed } from "../live/feed";
import { Leader } from "../live/leader";
import { parseMessage } from "../live/parse";
import { LiveProcessor } from "../live/processor";
import { reconcileAll, reconcileMatch } from "../live/reconcile";
import { ConsoleSink, createFirebaseSink, withCounts, type LiveSink } from "../live/sink";
import { log } from "../logger";
import { redis } from "../redis";
import { bump } from "../sync/stats";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const opt = (f: string) => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function chooseSink(): LiveSink {
  const configured = config.FIREBASE_SERVICE_ACCOUNT && config.FIREBASE_DATABASE_URL;
  const mode = opt("sink") ?? (configured ? "firebase" : "console");
  if (mode === "firebase") {
    if (!configured) throw new Error("Set FIREBASE_SERVICE_ACCOUNT and FIREBASE_DATABASE_URL in .env, or use --sink console");
    if (!existsSync(config.FIREBASE_SERVICE_ACCOUNT as string)) {
      throw new Error(`Service account file not found: ${config.FIREBASE_SERVICE_ACCOUNT}`);
    }
    log.info("Sink: Firebase Realtime Database");
    return createFirebaseSink(config.FIREBASE_SERVICE_ACCOUNT as string, config.FIREBASE_DATABASE_URL as string);
  }
  log.info("Sink: console (nothing is written to Firebase)");
  return new ConsoleSink(true);
}

async function main() {
  const { sink, counts } = withCounts(chooseSink());
  const processor = new LiveProcessor(sink, { archive: !has("no-archive"), cacheSnapshots: true });
  const leader = new Leader();

  // Match End is not proof the match is over (it can be the end of a day), so confirm over REST.
  processor.onMatchEnd = (id) => {
    setTimeout(() => {
      reconcileMatch(id, processor, "all", 10 * 60_000).catch((err) => log.error(`Match end check for ${id} failed:`, err));
    }, 60_000);
  };
  leader.onElected = () => void reconcileAll(processor);
  await leader.start();

  const feed = new Feed(`${config.ENTITY_WS_URL}?token=${config.ENTITY_TOKEN}`, {
    onMessage(raw, receivedAt) {
      if (!leader.isLeader()) return; // standby: stay connected, do nothing
      const msg = parseMessage(raw, receivedAt);
      if (!msg) {
        bump(processor.stats, "messages_ignored");
        return;
      }
      void processor.handle(msg);
    },
    onOpen(isReconnect) {
      if (isReconnect && leader.isLeader()) void reconcileAll(processor);
    },
  });
  feed.start();

  const beat = setInterval(() => {
    if (leader.isLeader()) sink.update({ "system/liveHeartbeat": Date.now() }).catch(() => undefined);
  }, 10_000);

  // Finished matches are removed from Firebase after 24 hours (only the leader does this).
  const cleanup = setInterval(() => {
    if (!leader.isLeader()) return;
    cleanupFinished(sink, processor).catch((err) => log.error("Firebase cleanup failed:", err));
  }, 10 * 60_000);
  const status = setInterval(() => {
    log.info(
      `Status: ${leader.isLeader() ? "leader" : "standby"}, socket ${feed.isOpen() ? "open" : "closed"}, ` +
        `${JSON.stringify(processor.stats)}, sink ${JSON.stringify(counts)}`,
    );
    log.info(`Latency (our side, socket to Firebase): ${processor.latency.summary()}`);
  }, 60_000);

  const shutdown = async () => {
    log.info("Shutting down...");
    clearInterval(beat);
    clearInterval(status);
    clearInterval(cleanup);
    feed.stop();
    await leader.stop();
    // Let background series syncs finish (at most 30 seconds) before the database and Redis are closed.
    await Promise.race([processor.waitForSyncs(), new Promise((r) => setTimeout(r, 30_000))]);
    await sink.close();
    await prisma.$disconnect();
    await redis.quit();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  log.error("Live service failed to start:", err);
  process.exit(1);
});