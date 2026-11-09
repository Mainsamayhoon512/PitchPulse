import { providerGet } from "../provider/client";
import { prisma } from "../db";
import { config } from "../config";
import { competitions, teams, venues } from "./entities";
import { list, normalizeCompetition, normalizeRound, normalizeTeam, normalizeVenue } from "./normalize";
import { bump, type Stats } from "./stats";

type ListResponse = { items?: unknown[]; total_pages?: number | string };

/** Syncs the competition list, page by page. status: live, fixture or result (omit for all). */
export async function syncCompetitionList(
  status?: "live" | "fixture" | "result",
  maxPages = Infinity,
): Promise<Stats> {
  const stats: Stats = {};
  for (let paged = 1; paged <= maxPages; paged++) {
    const { body } = await providerGet<ListResponse>("competitions", {
      status,
      per_page: config.SYNC_PER_PAGE,
      paged,
    });
    const items = body.response.items ?? [];
    for (const raw of items) {
      const n = normalizeCompetition(raw);
      if (!n) {
        bump(stats, "skipped");
        continue;
      }
      const result = await competitions.upsert(n);
      bump(stats, result.action);
    }
    const totalPages = Number(body.response.total_pages ?? 1);
    if (items.length === 0 || paged >= totalPages) break;
  }
  return stats;
}

/** One call that returns the competition's rounds, venues and teams. */
export async function syncCompetitionInfo(cid: number): Promise<{ id: number; stats: Stats }> {
  const stats: Stats = {};
  const { body } = await providerGet<Record<string, unknown>>(`competitions/${cid}/info`);
  const res = body.response;

  const n = normalizeCompetition({ ...res, cid });
  if (!n) throw new Error(`Competition ${cid}: the info response had no title`);
  const comp = await competitions.upsert(n);
  bump(stats, `competition_${comp.action}`);

  for (const raw of list(res.venue_list)) {
    const v = normalizeVenue(raw);
    if (!v) continue;
    bump(stats, `venue_${(await venues.upsert(v)).action}`);
  }

  const teamIds: number[] = [];
  for (const raw of list(res.teams)) {
    const t = normalizeTeam(raw);
    if (!t) continue;
    const r = await teams.upsert(t);
    bump(stats, `team_${r.action}`);
    teamIds.push(r.id);
  }
  if (teamIds.length > 0) {
    await prisma.competitionTeam.createMany({
      data: teamIds.map((teamId) => ({ competitionId: comp.id, teamId })),
      skipDuplicates: true,
    });
  }

  for (const raw of list(res.rounds)) {
    const rd = normalizeRound(raw);
    if (!rd) continue;
    await prisma.round.upsert({
      where: { rid: rd.rid },
      create: { rid: rd.rid, competitionId: comp.id, ...rd.data },
      update: { competitionId: comp.id, ...rd.data },
    });
    bump(stats, "rounds");
  }

  await prisma.competition.update({ where: { id: comp.id }, data: { infoSyncedAt: new Date() } });
  return { id: comp.id, stats };
}