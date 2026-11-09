import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../../db";
import { cached } from "../cache";
import { notFound } from "../errors";
import { playerSummary, teamDetail } from "../mappers";
import { byQuery, idParams } from "../schemas";

const whereId = (id: number, by: string): Prisma.TeamWhereInput => (by === "provider" ? { providerId: id } : { id });
const params = { params: idParams, querystring: { type: "object", properties: { ...byQuery } } };

export default async function teams(app: FastifyInstance) {
  app.get<{ Params: { id: number }; Querystring: { by: string } }>(
    "/teams/:id",
    { schema: { tags: ["Teams"], summary: "Team profile", ...params } },
    async (req) => {
      const { id } = req.params;
      const { by } = req.query;
      const result = await cached(`team:${by}:${id}`, 600, async () => {
        const t = await prisma.team.findFirst({ where: whereId(id, by) });
        return t ? teamDetail(t) : null;
      });
      if (!result) throw notFound("Team");
      return result;
    },
  );

  app.get<{ Params: { id: number }; Querystring: { by: string } }>(
    "/teams/:id/squads",
    {
      schema: {
        tags: ["Teams"],
        summary: "Squads of a team, newest series first",
        description: "A team can have several squads: one per series, and per date and format for tours.",
        ...params,
      },
    },
    async (req) => {
      const { id } = req.params;
      const { by } = req.query;
      const result = await cached(`team-squads:${by}:${id}`, 600, async () => {
        const t = await prisma.team.findFirst({ where: whereId(id, by), select: { id: true } });
        if (!t) return null;
        const rows = await prisma.squadEntry.findMany({
          where: { teamId: t.id },
          include: { player: true, competition: true },
          take: 600,
        });

        const groups = new Map<
          string,
          { competition: { id: number; title: string }; startDate: Date | null; date: string; format: string; players: ReturnType<typeof playerSummary>[] }
        >();
        for (const r of rows) {
          const key = `${r.competitionId}|${r.gmdate}|${r.format}`;
          let g = groups.get(key);
          if (!g) {
            g = {
              competition: { id: r.competition.id, title: r.competition.title },
              startDate: r.competition.dateStart,
              date: r.gmdate,
              format: r.format,
              players: [],
            };
            groups.set(key, g);
          }
          g.players.push(playerSummary(r.player));
        }
        const items = [...groups.values()]
          .sort((a, b) => (b.startDate?.getTime() ?? 0) - (a.startDate?.getTime() ?? 0) || b.date.localeCompare(a.date))
          .map(({ startDate, ...rest }) => rest);
        return { items };
      });
      if (!result) throw notFound("Team");
      return result;
    },
  );
}