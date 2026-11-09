import { providerGet } from "../provider/client";
import { prisma } from "../db";
import { config } from "../config";
import { teams, venues } from "./entities";
import { normalizeMatch } from "./normalize";
import { bump, type Stats } from "./stats";

type MatchListResponse = { items?: unknown[]; matches?: unknown[]; total_pages?: number | string };

export async function syncCompetitionMatches(competitionId: number, cid: number): Promise<Stats> {
  const stats: Stats = {};
  for (let paged = 1; ; paged++) {
    const { body } = await providerGet<MatchListResponse>(`competitions/${cid}/matches`, {
      per_page: config.SYNC_PER_PAGE,
      paged,
    });
    // the docs say "matches", the real response says "items"
    const items = body.response.items ?? body.response.matches ?? [];

    for (const raw of items) {
      const m = normalizeMatch(raw);
      if (!m) {
        bump(stats, "matches_skipped");
        continue;
      }
      const teamAId = m.teamA ? await teams.ensure(m.teamA) : null;
      const teamBId = m.teamB ? await teams.ensure(m.teamB) : null;
      const venueId = m.venue ? await venues.ensure(m.venue) : null;

      // Matches come only from the provider, so it is authoritative: plain upsert.
      const data = { competitionId, teamAId, teamBId, venueId, ...m.data };
      await prisma.match.upsert({
        where: { matchId: m.matchId },
        create: { matchId: m.matchId, ...data },
        update: data,
      });
      bump(stats, "matches");
    }

    const totalPages = Number(body.response.total_pages ?? 1);
    if (items.length === 0 || paged >= totalPages) break;
  }
  await prisma.competition.update({ where: { id: competitionId }, data: { matchesSyncedAt: new Date() } });
  return stats;
}