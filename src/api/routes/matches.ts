import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../../db";
import { cached, cachedValue } from "../cache";
import { notFound } from "../errors";
import { listMatches } from "../lookups";
import { playerNames } from "../lookups";
import { ball as mapBall, innings as mapInnings, matchDetail } from "../mappers";
import { idParams, MATCH_STATUS, pageQuery, type MatchStatusName } from "../schemas";

export default async function matches(app: FastifyInstance) {
  app.get<{
    Querystring: { status?: MatchStatusName; date?: string; competitionId?: number; teamId?: number; limit: number; offset: number };
  }>(
    "/matches",
    {
      schema: {
        tags: ["Matches"],
        summary: "List matches",
        description: "Newest first, or soonest first for status=upcoming. The date filter is a UTC day.",
        querystring: {
          type: "object",
          properties: {
            status: { type: "string", enum: Object.keys(MATCH_STATUS) },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "UTC day, YYYY-MM-DD" },
            competitionId: { type: "integer", minimum: 1 },
            teamId: { type: "integer", minimum: 1 },
            ...pageQuery,
          },
        },
      },
    },
    async (req) => {
      const q = req.query;
      const key = `matches:${q.status ?? ""}:${q.date ?? ""}:${q.competitionId ?? ""}:${q.teamId ?? ""}:${q.limit}:${q.offset}`;
      return cachedValue(key, q.status === "live" ? 5 : 30, () => listMatches(q));
    },
  );

  app.get<{ Params: { id: number } }>(
    "/matches/:id",
    { schema: { tags: ["Matches"], summary: "Match details", params: idParams } },
    async (req) => {
      const id = req.params.id;
      const result = await cached(`match:${id}`, (v) => (v.live ? 5 : 120), async () => {
        const row = await prisma.match.findUnique({
          where: { matchId: id },
          include: { teamA: true, teamB: true, venue: true, competition: true },
        });
        return row ? matchDetail(row) : null;
      });
      if (!result) throw notFound("Match");
      return result;
    },
  );

  app.get<{ Params: { id: number } }>(
    "/matches/:id/scorecard",
    {
      schema: {
        tags: ["Matches"],
        summary: "Scorecard by innings",
        description:
          "Full scorecards are stored once an innings is completed. For the innings in progress use the live data in Firebase.",
        params: idParams,
      },
    },
    async (req) => {
      const id = req.params.id;
      const result = await cached(`scorecard:${id}`, (v) => (v.live ? 10 : 600), async () => {
        const m = await prisma.match.findUnique({ where: { matchId: id }, select: { status: true } });
        const rows = await prisma.innings.findMany({ where: { matchId: id }, orderBy: { number: "asc" } });
        if (!m && rows.length === 0) return null;
        return { matchId: id, live: m?.status === 3, innings: rows.map(mapInnings) };
      });
      if (!result) throw notFound("Match");
      return result;
    },
  );

  app.get<{ Params: { id: number }; Querystring: { innings?: number; before?: number; limit: number } }>(
    "/matches/:id/balls",
    {
      schema: {
        tags: ["Matches"],
        summary: "Ball-by-ball history, newest first",
        description: "Pass the nextBefore value from one page as `before` to get the next page. Null means no more pages.",
        params: idParams,
        querystring: {
          type: "object",
          properties: {
            innings: { type: "integer", minimum: 1, description: "Innings number" },
            before: { type: "integer", minimum: 1, description: "Return balls with an eventId below this" },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
          },
        },
      },
    },
    async (req) => {
      const id = req.params.id;
      const { innings, before, limit } = req.query;
      const key = `balls:${id}:${innings ?? ""}:${before ?? ""}:${limit}`;
      const result = await cached(key, before === undefined ? 5 : 60, async () => {
        const where: Prisma.BallWhereInput = { matchId: id };
        if (innings) where.inningsNumber = innings;
        if (before) where.eventId = { lt: before };
        const rows = await prisma.ball.findMany({ where, orderBy: { eventId: "desc" }, take: limit });
        if (rows.length === 0) {
          // No balls: a 404 if we know nothing about the match, otherwise an empty page.
          const known = await prisma.match.findUnique({ where: { matchId: id }, select: { matchId: true } });
          if (!known && before === undefined && !(await prisma.ball.findFirst({ where: { matchId: id }, select: { eventId: true } }))) {
            return null;
          }
        }
        const names = await playerNames(rows);
        return {
          items: rows.map((b) => mapBall(b, names)),
          nextBefore: rows.length === limit ? (rows[rows.length - 1]?.eventId ?? null) : null,
        };
      });
      if (!result) throw notFound("Match");
      return result;
    },
  );
}