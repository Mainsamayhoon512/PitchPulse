import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../../db";
import { cached, cachedValue } from "../cache";
import { notFound } from "../errors";
import { playerDetail, playerSummary } from "../mappers";
import { byQuery, idParams } from "../schemas";

const whereId = (id: number, by: string): Prisma.PlayerWhereInput => (by === "provider" ? { providerId: id } : { id });

export default async function players(app: FastifyInstance) {
  app.get<{ Querystring: { search: string; limit: number } }>(
    "/players",
    {
      schema: {
        tags: ["Players"],
        summary: "Search players by name",
        querystring: {
          type: "object",
          required: ["search"],
          properties: {
            search: { type: "string", minLength: 2, maxLength: 60 },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (req) => {
      const { search, limit } = req.query;
      return cachedValue(`players:${search.toLowerCase()}:${limit}`, 60, async () => {
        const rows = await prisma.player.findMany({
          where: { title: { contains: search, mode: "insensitive" } },
          orderBy: { title: "asc" },
          take: limit,
        });
        return { items: rows.map(playerSummary) };
      });
    },
  );

  app.get<{ Params: { id: number }; Querystring: { by: string } }>(
    "/players/:id",
    {
      schema: {
        tags: ["Players"],
        summary: "Player profile",
        params: idParams,
        querystring: { type: "object", properties: { ...byQuery } },
      },
    },
    async (req) => {
      const { id } = req.params;
      const { by } = req.query;
      const result = await cached(`player:${by}:${id}`, 600, async () => {
        const p = await prisma.player.findFirst({ where: whereId(id, by) });
        return p ? playerDetail(p) : null;
      });
      if (!result) throw notFound("Player");
      return result;
    },
  );
}