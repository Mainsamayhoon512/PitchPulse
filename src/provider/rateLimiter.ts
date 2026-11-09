import { redis } from "../redis";
import { log } from "../logger";
import { sleep } from "../utils";

/** Waits (if needed) until we are allowed to make one more provider call. */
export async function acquire(maxPerMinute: number): Promise<void> {
  for (;;) {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `ratelimit:provider:${minute}`;

    await redis.set(key, 0, "EX", 120, "NX"); // create the counter if missing
    const count = await redis.incr(key);

    if (count <= maxPerMinute) return;

    const waitMs = 60_000 - (Date.now() % 60_000) + 100;
    log.warn(`Rate limit reached (${maxPerMinute}/min). Waiting ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs);
  }
}