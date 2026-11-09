import { prisma } from "../db";
import { log } from "../logger";
import { redis } from "../redis";
import { FINISHED_KEY, type LiveProcessor } from "./processor";
import type { LiveSink } from "./sink";

export const FINISHED_KEEP_MS = 24 * 3_600_000;

/** Which of these matches are safely in Postgres: the match row exists, is completed, and its balls were saved. */
export async function archivedInDatabase(ids: number[]): Promise<Set<number>> {
  const completed = await prisma.match.findMany({ where: { matchId: { in: ids }, status: 2 }, select: { matchId: true } });
  const safe = new Set<number>();
  for (const { matchId } of completed) {
    if ((await prisma.ball.count({ where: { matchId }, take: 1 })) > 0) safe.add(matchId);
  }
  return safe;
}

/**
 * Removes matches from Firebase that finished more than `keepMs` ago, so the live node does not grow forever.
 * A match is only removed once Postgres holds it (see archivedInDatabase). Otherwise it stays in Firebase and is
 * checked again on the next run, so no data is lost if Postgres was down. Returns the ids that were removed.
 */
export async function cleanupFinished(
  sink: LiveSink,
  processor: LiveProcessor,
  root = "live",
  keepMs = FINISHED_KEEP_MS,
  now = Date.now(),
  isArchived: (ids: number[]) => Promise<Set<number>> = archivedInDatabase,
): Promise<number[]> {
  const due = (await redis.zrangebyscore(FINISHED_KEY, 0, now - keepMs, "LIMIT", 0, 50)).map(Number);
  if (due.length === 0) return [];

  const safe = await isArchived(due);
  const keep = due.filter((id) => !safe.has(id));
  if (keep.length > 0) log.warn(`Not removing match(es) ${keep.join(", ")} from Firebase: not found in Postgres yet`);
  const remove = due.filter((id) => safe.has(id));
  if (remove.length === 0) return [];

  const updates: Record<string, null> = {};
  for (const id of remove) updates[`${root}/${id}`] = null; // null deletes the whole match node
  await sink.update(updates);

  // The processor must forget these matches, otherwise it would think Firebase still has them and never write them again.
  for (const id of remove) processor.forgetMatch(id);
  await redis.zrem(FINISHED_KEY, ...remove.map(String));
  log.info(`Removed ${remove.length} finished match(es) from Firebase: ${remove.join(", ")}`);
  return remove;
}
