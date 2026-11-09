import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyError } from "fastify";
import { config } from "../config";
import { redis } from "../redis";
import health from "./routes/health";
import matches from "./routes/matches";
import players from "./routes/players";
import series from "./routes/series";
import teams from "./routes/teams";

export function parseTrustProxy(v: string): boolean | string[] | ((address: string, hop: number) => boolean) {
  const s = v.trim().toLowerCase();
  if (s === "" || s === "false") return false;
  if (s === "true") return true;
  if (/^\d+$/.test(s)) {
    const hops = Number(s); // trust this many proxies in front of the API
    return (_address, hop) => hop < hops;
  }
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

export async function buildApp() {
  const app = Fastify({
    logger: { level: "info" },
    trustProxy: parseTrustProxy(config.API_TRUST_PROXY), // see API_TRUST_PROXY in config.ts
  });

  // API documentation: Swagger page at /docs, the OpenAPI file at /docs/json
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Cricket API",
        version: "0.1.0",
        description:
          "Match history, scorecards, series, teams and players. Live match data is in Firebase under live/{matchId}.",
      },
      tags: [{ name: "Matches" }, { name: "Series" }, { name: "Teams" }, { name: "Players" }],
    },
  });
  if (config.API_DOCS_ENABLED) await app.register(swaggerUi, { routePrefix: "/docs" });

  if (config.API_CORS_ORIGINS === "*" && process.env.NODE_ENV === "production") {
    app.log.warn("API_CORS_ORIGINS is * in production. Set it to the origins that should be allowed.");
  }
  await app.register(cors, {
    origin: config.API_CORS_ORIGINS === "*" ? true : config.API_CORS_ORIGINS.split(",").map((s) => s.trim()),
  });

  // Limits are counted in Redis, so they are shared by every copy of the API.
  // Per IP address for now; it becomes per user once sign-in exists.
  await app.register(rateLimit, {
    max: config.API_RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    redis,
    nameSpace: "api-rl:",
    allowList: (req) => req.url === "/health" || req.url === "/ready",
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.status(status).send({ error: { code: status, message: status >= 500 ? "Internal server error" : err.message } });
  });
  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: 404, message: "Route not found" } });
  });

  await app.register(health);
  await app.register(matches, { prefix: "/v1" });
  await app.register(series, { prefix: "/v1" });
  await app.register(teams, { prefix: "/v1" });
  await app.register(players, { prefix: "/v1" });

  return app;
}