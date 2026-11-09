import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupFinished } from "../src/live/cleanup";
import { FINISHED_KEY, LiveProcessor } from "../src/live/processor";
import type { LiveSink } from "../src/live/sink";
import { redis } from "../src/redis";

const DAY = 24 * 3_600_000;
const allSaved = async (ids: number[]) => new Set(ids);

class RecordingSink implements LiveSink {
  writes: Record<string, unknown>[] = [];
  async update(values: Record<string, unknown>) {
    this.writes.push(values);
  }
  async close() {}
}

beforeEach(async () => {
  await redis.del(FINISHED_KEY);
});
afterAll(async () => {
  await redis.del(FINISHED_KEY);
  await redis.quit();
});

describe("cleanupFinished", () => {
  it("removes matches that finished more than 24 hours ago, and only those", async () => {
    const now = Date.now();
    await redis.zadd(FINISHED_KEY, String(now - 25 * 3_600_000), "111", String(now - 1 * 3_600_000), "222");
    const sink = new RecordingSink();
    const removed = await cleanupFinished(sink, new LiveProcessor(sink, { archive: false }), "test", DAY, now, allSaved);
    expect(removed).toEqual([111]);
    expect(sink.writes).toEqual([{ "test/111": null }]); // null deletes the node
    expect(await redis.zrange(FINISHED_KEY, "0", "-1")).toEqual(["222"]);
  });

  it("keeps a match in Firebase until Postgres holds it", async () => {
    const now = Date.now();
    await redis.zadd(FINISHED_KEY, String(now - 25 * 3_600_000), "111", String(now - 26 * 3_600_000), "333");
    const sink = new RecordingSink();
    const onlyIn333 = async () => new Set([333]); // 111 is not saved in Postgres
    const removed = await cleanupFinished(sink, new LiveProcessor(sink, { archive: false }), "test", DAY, now, onlyIn333);
    expect(removed).toEqual([333]);
    expect(sink.writes).toEqual([{ "test/333": null }]); // 111 is NOT deleted from Firebase
    expect(await redis.zrange(FINISHED_KEY, "0", "-1")).toEqual(["111"]); // and stays queued to be checked again
  });

  it("does nothing when nothing is due", async () => {
    const sink = new RecordingSink();
    expect(await cleanupFinished(sink, new LiveProcessor(sink, { archive: false }), "test")).toEqual([]);
    expect(sink.writes).toHaveLength(0);
  });
});
