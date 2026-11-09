import { prisma } from "../db";
import { log } from "../logger";
import { mergeProviderRecord, type Delegate, type MergeResult, type Row } from "./merge";
import type { Normalized } from "./normalize";

type Finder = (data: Row) => Promise<any | null>;

/** Used by "ensure": provider id -> our id, remembered during one run. */
const caches = {
  competition: new Map<number, number>(),
  team: new Map<number, number>(),
  venue: new Map<number, number>(),
  player: new Map<number, number>(),
};

export function clearIdCache(): void {
  for (const c of Object.values(caches)) c.clear();
}

function makeEntity(entity: string, delegate: Delegate, cache: Map<number, number>, finder?: Finder) {
  /** Always merges the record into the database. */
  const upsert = async (n: Normalized): Promise<MergeResult> => {
    const result = await mergeProviderRecord({
      entity,
      delegate,
      providerId: n.providerId,
      data: n.data,
      findAdminMatch: finder,
    });
    cache.set(n.providerId, result.id);
    if (result.action === "linked") {
      log.info(`${entity} "${String(n.data.title ?? n.data.name)}" linked to an admin-created record`);
    }
    return result;
  };
  /** Returns our id, merging only if we have not seen this record during this run. */
  const ensure = async (n: Normalized): Promise<number> => cache.get(n.providerId) ?? (await upsert(n)).id;
  return { upsert, ensure };
}

// ---------- rules for linking an admin-created record to a provider record ----------
// Conservative on purpose: when unsure, create a new record and let the admin merge later.

const findPlayerMatch: Finder = async (data) => {
  const title = data.title as string;
  const candidates = await prisma.player.findMany({
    where: { providerId: null, title: { equals: title, mode: "insensitive" } },
  });
  if (candidates.length === 0) return null;

  const born = data.birthdate instanceof Date ? data.birthdate.getTime() : null;
  const exact = candidates.filter((c) => born !== null && c.birthdate && c.birthdate.getTime() === born);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    log.warn(`Player "${title}": ${exact.length} admin records share name and birthdate. Not linked`);
    return null;
  }
  // No birthdate to compare: accept a single candidate from the same country
  const loose = candidates.filter(
    (c) => (born === null || !c.birthdate) && (!c.country || !data.country || c.country === data.country),
  );
  if (loose.length === 1) return loose[0];
  log.warn(`Player "${title}": unclear match with ${candidates.length} admin record(s). Created as new`);
  return null;
};

const findTeamMatch: Finder = async (data) => {
  const candidates = await prisma.team.findMany({
    where: { providerId: null, title: { equals: data.title as string, mode: "insensitive" } },
  });
  const ok = candidates.filter((c) => !c.country || !data.country || c.country === data.country);
  return ok.length === 1 ? ok[0] : null;
};

const findVenueMatch: Finder = async (data) => {
  const candidates = await prisma.venue.findMany({
    where: { providerId: null, name: { equals: data.name as string, mode: "insensitive" } },
  });
  const ok = candidates.filter((c) => !c.city || !data.city || c.city === data.city);
  return ok.length === 1 ? ok[0] : null;
};

const findCompetitionMatch: Finder = async (data) => {
  const candidates = await prisma.competition.findMany({
    where: { providerId: null, title: { equals: data.title as string, mode: "insensitive" } },
  });
  const ok = candidates.filter((c) => !c.season || !data.season || c.season === data.season);
  return ok.length === 1 ? ok[0] : null;
};

export const competitions = makeEntity(
  "Competition", prisma.competition as unknown as Delegate, caches.competition, findCompetitionMatch);
export const teams = makeEntity("Team", prisma.team as unknown as Delegate, caches.team, findTeamMatch);
export const venues = makeEntity("Venue", prisma.venue as unknown as Delegate, caches.venue, findVenueMatch);
export const players = makeEntity("Player", prisma.player as unknown as Delegate, caches.player, findPlayerMatch);