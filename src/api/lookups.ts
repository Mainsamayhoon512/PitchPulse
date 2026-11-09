import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { MATCH_STATUS, type MatchStatusName } from "./schemas";
import { matchSummary, type PlayerNames } from "./mappers";

/** Batsman and bowler names for a page of balls (balls store the provider's player ids). */
export async function playerNames(rows: { batsmanProviderId: number | null; bowlerProviderId: number | null }[]): Promise<PlayerNames> {
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.batsmanProviderId) ids.add(r.batsmanProviderId);
    if (r.bowlerProviderId) ids.add(r.bowlerProviderId);
  }
  if (ids.size === 0) return new Map();
  const players = await prisma.player.findMany({
    where: { providerId: { in: [...ids] } },
    select: { id: true, providerId: true, title: true },
  });
  return new Map(players.map((p) => [p.providerId as number, { id: p.id, name: p.title }]));
}

export interface MatchFilter {
  status?: MatchStatusName;
  date?: string; // UTC day, YYYY-MM-DD
  competitionId?: number;
  teamId?: number;
  limit: number;
  offset: number;
}

export async function listMatches(f: MatchFilter) {
  const where: Prisma.MatchWhereInput = {};
  if (f.status) where.status = MATCH_STATUS[f.status];
  if (f.date) {
    const from = new Date(`${f.date}T00:00:00.000Z`);
    where.dateStart = { gte: from, lt: new Date(from.getTime() + 86_400_000) };
  }
  if (f.competitionId) where.competitionId = f.competitionId;
  if (f.teamId) where.OR = [{ teamAId: f.teamId }, { teamBId: f.teamId }];

  const rows = await prisma.match.findMany({
    where,
    include: { teamA: true, teamB: true, venue: true, competition: true },
    orderBy: { dateStart: f.status === "upcoming" ? "asc" : "desc" },
    take: f.limit,
    skip: f.offset,
  });
  return { items: rows.map(matchSummary), limit: f.limit, offset: f.offset };
}