import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, parseTrustProxy } from "../src/api/app";
import { prisma } from "../src/db";
import { redis } from "../src/redis";

// These tests need Postgres and Redis (docker compose up -d). They only read from the database.
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await redis.quit();
});

describe("API", () => {
  it("answers /health and /ready", async () => {
    expect((await app.inject("/health")).json()).toEqual({ ok: true });
    const ready = await app.inject("/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks).toMatchObject({ postgres: true, redis: true });
  });

  it("serves Swagger UI and the OpenAPI document", async () => {
    expect((await app.inject("/docs/")).statusCode).toBe(200);
    const spec = (await app.inject("/docs/json")).json();
    expect(spec.info.title).toBe("Cricket API");
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/v1/matches",
        "/v1/matches/{id}",
        "/v1/matches/{id}/scorecard",
        "/v1/matches/{id}/balls",
        "/v1/series",
        "/v1/teams/{id}",
        "/v1/players",
      ]),
    );
  });

  it("lists matches in the documented shape", async () => {
    const res = await app.inject("/v1/matches?limit=2");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: expect.any(Array), limit: 2, offset: 0 });
  });

  it("returns 404 in the standard error shape for unknown records", async () => {
    const urls = [
      "/v1/matches/999999999",
      "/v1/matches/999999999/scorecard",
      "/v1/matches/999999999/balls",
      "/v1/teams/999999999",
      "/v1/players/999999999",
      "/v1/series/999999999",
    ];
    for (const url of urls) {
      const res = await app.inject(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error.code).toBe(404);
    }
    expect((await app.inject("/nope")).statusCode).toBe(404);
  });

  it("returns 400 for bad parameters", async () => {
    expect((await app.inject("/v1/players?search=a")).statusCode).toBe(400); // too short
    expect((await app.inject("/v1/players")).statusCode).toBe(400); // missing
    expect((await app.inject("/v1/matches?status=sometimes")).statusCode).toBe(400);
    expect((await app.inject("/v1/matches/abc")).statusCode).toBe(400);
  });
});

describe("parseTrustProxy", () => {
  it("understands each form of API_TRUST_PROXY", () => {
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("10.0.0.1, 10.0.0.2")).toEqual(["10.0.0.1", "10.0.0.2"]);
    const hops = parseTrustProxy("1") as (a: string, hop: number) => boolean;
    expect(hops("1.1.1.1", 0)).toBe(true); // the nearest proxy is trusted
    expect(hops("1.1.1.1", 1)).toBe(false); // anything further away is not
  });
});
