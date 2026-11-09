import { prisma } from "../db";
import { players } from "../sync/entities";
import { normalizePlayer } from "../sync/normalize";
import type { BallRow, InningsRow, MatchUpdate } from "./mapSnapshot";

export async function archiveBalls(rows: BallRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 25) {
    await Promise.all(
      rows.slice(i, i + 25).map((row) => {
        // const { matchId, eventId, ...rest } = row;
        const { matchId, eventId, providerTime, ...rest } = row;
        return prisma.ball.upsert({
          where: { matchId_eventId: { matchId, eventId } },
          create: row,
          update: rest,
        });
      }),
    );
  }
}

export async function archiveInnings(rows: InningsRow[]): Promise<void> {
  for (const row of rows) {
    const { iid, ...rest } = row;
    await prisma.innings.upsert({ where: { iid }, create: row, update: rest });
  }
}

/** Does nothing if the match is not in the database yet (the REST sync creates match rows). */
export async function updateMatchStatus(matchId: number, data: MatchUpdate): Promise<number> {
  const result = await prisma.match.updateMany({ where: { matchId }, data });
  return result.count;
}

/** Players in a snapshot go through the same merge rules as the REST sync. */
export async function archivePlayers(raw: unknown[]): Promise<void> {
  for (const r of raw) {
    const p = normalizePlayer(r);
    if (p) await players.upsert(p);
  }
}