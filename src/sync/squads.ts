import { providerGet } from "../provider/client";
import { prisma } from "../db";
import { players, teams } from "./entities";
import { list, normalizePlayer, normalizeTeam, obj, toStr } from "./normalize";
import { bump, type Stats } from "./stats";

type SquadsResponse = { squad_type?: string; squads?: unknown[] };

/**
 * Squads belong to a competition, not to a player.
 * per_team leagues: one squad per team. per_match tours: the same team appears once per match or format.
 */
export async function syncSquads(competitionId: number, cid: number): Promise<Stats> {
  const stats: Stats = {};
  const { body } = await providerGet<SquadsResponse>(`competitions/${cid}/squads`);
  const squadType = toStr(body.response.squad_type);

  const playerIds = new Map<number, number>(); // provider pid -> our id, for this run
  const rows: {
    competitionId: number;
    teamId: number;
    playerId: number;
    gmdate: string;
    format: string;
    squadType: string | null;
  }[] = [];

  for (const rawSquad of list(body.response.squads)) {
    const s = obj(rawSquad);
    const team = normalizeTeam(s.team ?? { tid: s.team_id, title: s.title });
    if (!team) {
      bump(stats, "squads_skipped");
      continue;
    }
    const teamId = (await teams.upsert(team)).id;
    const gmdate = toStr(s.gmdate) ?? "";
    const format = toStr(s.format_str ?? s.format) ?? "";

    for (const rawPlayer of list(s.players)) {
      const p = normalizePlayer(rawPlayer);
      if (!p) {
        bump(stats, "players_skipped");
        continue;
      }
      let playerId = playerIds.get(p.providerId);
      if (playerId === undefined) {
        const r = await players.upsert(p);
        playerId = r.id;
        playerIds.set(p.providerId, playerId);
        bump(stats, `player_${r.action}`);
      }
      rows.push({ competitionId, teamId, playerId, gmdate, format, squadType });
    }
  }

  // Replace the squad as one step. An empty response never wipes what we already have.
  if (rows.length > 0) {
    await prisma.$transaction([
      prisma.squadEntry.deleteMany({ where: { competitionId } }),
      prisma.squadEntry.createMany({ data: rows, skipDuplicates: true }),
    ]);
    bump(stats, "squad_entries", rows.length);
  }
  await prisma.competition.update({ where: { id: competitionId }, data: { squadsSyncedAt: new Date() } });
  return stats;
}