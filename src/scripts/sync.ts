import { prisma } from "../db";
import { redis } from "../redis";
import { log } from "../logger";
import { clearIdCache } from "../sync/entities";
import { syncCompetitionList } from "../sync/competitions";
import { syncCompetition, syncLive } from "../sync/orchestrator";
import type { Stats } from "../sync/stats";

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const option = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const USAGE = `Usage:
  npm run sync -- live [--limit 10] [--force]     live + upcoming competitions (limit 0 = all)
  npm run sync -- competition <cid> [--force]     one competition (provider id)
  npm run sync -- competitions [live|fixture|result]   competition list only
  npm run sync -- status                          row counts in the database`;

async function recorded(job: string, scope: string, fn: () => Promise<Stats>): Promise<Stats> {
  const run = await prisma.syncRun.create({ data: { job, scope } });
  try {
    const stats = await fn();
    await prisma.syncRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok: true, stats } });
    return stats;
  } catch (err) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, error: (err as Error).message },
    });
    throw err;
  }
}

async function main() {
  clearIdCache();
  switch (command) {
    case "live": {
      const limit = Number(option("limit") ?? 10);
      const stats = await recorded("live", `limit=${limit}`, () => syncLive({ limit, force: flag("force") }));
      log.info("Done:", stats);
      break;
    }
    case "competition": {
      const cid = Number(rest[0]);
      if (!Number.isInteger(cid)) throw new Error("Give a competition id, e.g. npm run sync -- competition 130173");
      const stats = await recorded("competition", String(cid), () => syncCompetition(cid, flag("force")));
      log.info("Done:", stats);
      break;
    }
    case "competitions": {
      const status = rest[0] as "live" | "fixture" | "result" | undefined;
      const stats = await recorded("competitions", status ?? "all", () => syncCompetitionList(status));
      log.info("Done:", stats);
      break;
    }
    case "status": {
      const counts = {
        competitions: await prisma.competition.count(),
        rounds: await prisma.round.count(),
        teams: await prisma.team.count(),
        venues: await prisma.venue.count(),
        players: await prisma.player.count(),
        squadEntries: await prisma.squadEntry.count(),
        matches: await prisma.match.count(),
        changeLog: await prisma.changeLog.count(),
      };
      console.table(counts);
      break;
    }
    default:
      console.log(USAGE);
  }
}

main()
  .catch((err) => {
    log.error("Sync failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });