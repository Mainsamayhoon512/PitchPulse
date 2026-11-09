import { buildApp } from "../api/app";
import { config } from "../config";
import { prisma } from "../db";
import { log } from "../logger";
import { redis } from "../redis";

async function main() {
  const app = await buildApp();
  await app.listen({ port: config.PORT, host: config.API_HOST });
  log.info(`API listening on port ${config.PORT}. Docs at http://localhost:${config.PORT}/docs`);

  const shutdown = async () => {
    log.info("Shutting down API...");
    await app.close();
    await prisma.$disconnect();
    await redis.quit();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  log.error("API failed to start:", err);
  process.exit(1);
});