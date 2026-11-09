import { prisma } from "../db";
import { log } from "../logger";
import { ProviderError } from "../provider/client";
import { clearIdCache } from "./entities";
import { syncCompetitionInfo, syncCompetitionList } from "./competitions";
import { syncSquads } from "./squads";
import { syncCompetitionMatches } from "./matches";
import { addStats, bump, type Stats } from "./stats";

const HOUR = 3_600_000;
// How long a part counts as fresh. --force ignores these.
const MAX_AGE = { info: 24 * HOUR, squads: 12 * HOUR, matches: 10 * 60_000 };

const isStale = (at: Date | null | undefined, maxAgeMs: number, force: boolean) =>
  force || !at || Date.now() - at.getTime() > maxAgeMs;

/** Runs one part. A failure is logged and counted, and the other parts still run. */
async function guarded<T>(label: string, stats: Stats, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await fn();
    bump(stats, `${label}_ok`);
    return result;
  } catch (err) {
    if (err instanceof ProviderError && err.providerStatus === "accessdenied") {
      log.warn(`${label}: not allowed on this token (accessdenied)`);
      bump(stats, `${label}_denied`);
    } else {
      log.error(`${label} failed:`, err);
      bump(stats, `${label}_failed`);
    }
    return undefined;
  }
}

/** Info, then squads, then matches for one competition (provider id). */
export async function syncCompetition(cid: number, force = false): Promise<Stats> {
  const stats: Stats = {};
  const comp = await prisma.competition.findUnique({ where: { providerId: cid } });

  let id = comp?.id;
  if (!comp || isStale(comp.infoSyncedAt, MAX_AGE.info, force)) {
    const info = await guarded(`info[${cid}]`, stats, () => syncCompetitionInfo(cid));
    if (info) {
      id = info.id;
      addStats(stats, info.stats);
    }
  }
  if (id === undefined) {
    log.warn(`Competition ${cid} is not in the database and its info failed. Skipping`);
    return stats;
  }
  const competitionId = id;

  if (!comp || isStale(comp.squadsSyncedAt, MAX_AGE.squads, force)) {
    const s = await guarded(`squads[${cid}]`, stats, () => syncSquads(competitionId, cid));
    if (s) addStats(stats, s);
  }
  if (!comp || isStale(comp.matchesSyncedAt, MAX_AGE.matches, force)) {
    const m = await guarded(`matches[${cid}]`, stats, () => syncCompetitionMatches(competitionId, cid));
    if (m) addStats(stats, m);
  }
  return stats;
}

/** Live and upcoming competitions. limit 0 means all of them. */
export async function syncLive(opts: { limit: number; force: boolean }): Promise<Stats> {
  clearIdCache();
  const stats: Stats = {};

  for (const status of ["live", "fixture"] as const) {
    log.info(`Syncing the ${status} competition list...`);
    addStats(stats, await syncCompetitionList(status), `list_${status}_`);
  }

  const comps = await prisma.competition.findMany({
    where: { status: { in: ["live", "fixture"] }, providerId: { not: null } },
    orderBy: [{ status: "desc" }, { dateStart: "asc" }], // live first, then the soonest upcoming
    ...(opts.limit > 0 ? { take: opts.limit } : {}),
  });

  let i = 0;
  for (const c of comps) {
    i++;
    log.info(`[${i}/${comps.length}] ${c.providerId} ${c.title} (${c.status})`);
    addStats(stats, await syncCompetition(c.providerId as number, opts.force));
  }
  return stats;
}