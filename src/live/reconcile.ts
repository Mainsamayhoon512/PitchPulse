import { prisma } from "../db";
import { log } from "../logger";
import { providerGet } from "../provider/client";
import { redis } from "../redis";
import { list, obj, toInt } from "../sync/normalize";
import { mapBall, type BallRow } from "./mapSnapshot";
import type { LiveProcessor } from "./processor";


const lastRun = new Map<number, number>();

/**
 * Re-fetches one match over REST and feeds it through the processor.
 * scope "live": only the current innings' ball history. scope "all": every innings (match end).
 */
export async function reconcileMatch(
  matchId: number,
  processor: LiveProcessor,
  scope: "live" | "all",
  minGapMs = 0,
): Promise<void> {
  const now = Date.now();
  if (now - (lastRun.get(matchId) ?? 0) < minGapMs) return;
  lastRun.set(matchId, now);

  const { body } = await providerGet<Record<string, unknown>>(`matches/${matchId}/info`);
  const res = body.response;
  await processor.handle({
    kind: "snapshot",
    matchId,
    providerTs: now,
    response: { ...res, match_id: matchId },
    receivedAt: now,
    force: true,
  });
  await processor.waitFor(matchId);

  const live = obj(res.live);
  const numbers: number[] =
    scope === "all"
      ? list(obj(res.scorecard).innings).map((i) => toInt(obj(i).number)).filter((n): n is number => n !== null)
      : [toInt(live.live_inning_number) ?? toInt(obj(res.match_info).latest_inning_number)].filter(
          (n): n is number => n !== null,
        );

  for (const n of numbers) {
    const { body: cb } = await providerGet<Record<string, unknown>>(`matches/${matchId}/innings/${n}/commentary`);
    const iid = toInt(obj(cb.response.inning).iid);
    if (iid === null) continue;
    const rows = list(cb.response.commentaries)
      .map((c) => mapBall(c, matchId, iid, n))
      .filter((b): b is BallRow => b !== null);
    const changed = await processor.ingestBalls(matchId, rows);
    log.info(`Match ${matchId} innings ${n}: ${rows.length} balls fetched, ${changed} new or changed`);
  }
}

/** After a reconnect or an election: every match we saw recently, plus live matches in the database. */
export async function reconcileAll(processor: LiveProcessor, maxAgeMs = 30 * 60_000, cap = 30): Promise<void> {
  const ids = new Set(processor.activeMatchIds(maxAgeMs));
    // matches the previous leader was serving in the last 30 minutes
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "live:active:*", "COUNT", 100);
    cursor = next;
    for (const k of keys) {
      const id = Number(k.split(":")[2]);
      if (Number.isFinite(id)) ids.add(id);
    }
  } while (cursor !== "0");
  const dbLive = await prisma.match.findMany({ where: { status: 3 }, select: { matchId: true }, take: cap });
  dbLive.forEach((m) => ids.add(m.matchId));
  log.info(`Reconciling ${Math.min(ids.size, cap)} match(es) over REST...`);
  for (const id of [...ids].slice(0, cap)) {
    try {
      await reconcileMatch(id, processor, "live", 60_000);
    } catch (err) {
      log.error(`Reconcile of match ${id} failed:`, err);
    }
  }
}