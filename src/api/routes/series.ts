import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../../db";
import { cached, cachedValue } from "../cache";
import { notFound } from "../errors";
import { listMatches } from "../lookups";
import { competition, round, team } from "../mappers";
import { byQuery, idParams, MATCH_STATUS, pageQuery, type MatchStatusName } from "../schemas";

const whereId = (id: number, by: string): Prisma.CompetitionWhereInput => (by === "provider" ? { providerId: id } : { id });

export default async function series(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string; search?: string; limit: number; offset: number } }>(
    "/series",
    {
      schema: {
        tags: ["Series"],
        summary: "List series and tournaments",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["live", "fixture", "result"] },
            search: { type: "string", minLength: 2, maxLength: 60 },
            ...pageQuery,
          },
        },
      },
    },
    async (req) => {
      const { status, search, limit, offset } = req.query;
      return cachedValue(`series:${status ?? ""}:${search ?? ""}:${limit}:${offset}`, 60, async () => {
        const where: Prisma.CompetitionWhereInput = {};
        if (status) where.status = status;
        if (search) where.title = { contains: search, mode: "insensitive" };
        const rows = await prisma.competition.findMany({
          where,
          orderBy: { dateStart: { sort: "desc", nulls: "last" } },
          take: limit,
          skip: offset,
        });
        return { items: rows.map(competition), limit, offset };
      });
    },
  );

  app.get<{ Params: { id: number }; Querystring: { by: string } }>(
    "/series/:id",
    {
      schema: {
        tags: ["Series"],
        summary: "Series details with rounds and teams",
        params: idParams,
        querystring: { type: "object", properties: { ...byQuery } },
      },
    },
    async (req) => {
      const { id } = req.params;
      const { by } = req.query;
      const result = await cached(`series:${by}:${id}`, 300, async () => {
        const c = await prisma.competition.findFirst({
          where: whereId(id, by),
          include: { rounds: { orderBy: { order: "asc" } }, teams: { include: { team: true } } },
        });
        if (!c) return null;
        return { ...competition(c), rounds: c.rounds.map(round), teams: c.teams.map((ct) => team(ct.team)) };
      });
      if (!result) throw notFound("Series");
      return result;
    },
  );

  app.get<{ Params: { id: number }; Querystring: { by: string; status?: MatchStatusName; limit: number; offset: number } }>(
    "/series/:id/matches",
    {
      schema: {
        tags: ["Series"],
        summary: "Matches in a series",
        params: idParams,
        querystring: {
          type: "object",
          properties: { ...byQuery, status: { type: "string", enum: Object.keys(MATCH_STATUS) }, ...pageQuery },
        },
      },
    },
    async (req) => {
      const { id } = req.params;
      const { by, status, limit, offset } = req.query;
      const result = await cached(`series-matches:${by}:${id}:${status ?? ""}:${limit}:${offset}`, 30, async () => {
        const c = await prisma.competition.findFirst({ where: whereId(id, by), select: { id: true } });
        if (!c) return null;
        return listMatches({ status, competitionId: c.id, limit, offset });
      });
      if (!result) throw notFound("Series");
      return result;
    },
  );
}