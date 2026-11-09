import type { FastifyInstance } from "fastify";
import { prisma } from "../../db";
import { redis } from "../../redis";

export default async function health(app: FastifyInstance) {
  // Is the process alive? No dependencies checked.
  app.get("/health", { schema: { hide: true } }, async () => ({ ok: true }));

  // Can it serve requests? A stopped live service is reported but does not take the API out of rotation.
  app.get("/ready", { schema: { hide: true } }, async (_req, reply) => {
    const checks = { postgres: false, redis: false, liveService: false };
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = true;
    } catch {
      // stays false
    }
    try {
      await redis.ping();
      checks.redis = true;
      checks.liveService = (await redis.exists("live:leader")) === 1;
    } catch {
      // stays false
    }
    const ok = checks.postgres && checks.redis;
    return reply.status(ok ? 200 : 503).send({ ok, checks });
  });
}