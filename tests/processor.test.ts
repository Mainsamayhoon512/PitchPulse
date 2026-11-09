import { afterAll, describe, expect, it } from "vitest";
import { LiveProcessor } from "../src/live/processor";
import { parseMessage } from "../src/live/parse";
import type { LiveSink } from "../src/live/sink";
import { redis } from "../src/redis";
import { fixtureMessages } from "./fixture";

class RecordingSink implements LiveSink {
  writes: Record<string, unknown>[] = [];
  async update(values: Record<string, unknown>) {
    this.writes.push(values);
  }
  async close() {}
  paths = () => this.writes.flatMap((w) => Object.keys(w));
}

const messages = fixtureMessages(400).map((m) => parseMessage(m, Date.now()));

async function feed(processor: LiveProcessor, force = false) {
  for (const m of messages) {
    if (!m) continue;
    void processor.handle(force && m.kind === "snapshot" ? { ...m, force: true } : m);
  }
  await processor.drain();
}

afterAll(async () => {
  await redis.quit();
});

describe("LiveProcessor (no database, recording sink)", () => {
  it("writes sections, balls and lastEvent to Firebase paths", async () => {
    const sink = new RecordingSink();
    const p = new LiveProcessor(sink, { archive: false, root: "test" });
    await feed(p);
    const paths = sink.paths();
    expect(paths.some((x) => /^test\/\d+\/status$/.test(x))).toBe(true);
    expect(paths.some((x) => /^test\/\d+\/balls\/\d+$/.test(x))).toBe(true);
    expect(paths.some((x) => /^test\/\d+\/lastEvent$/.test(x))).toBe(true);
    expect(paths.some((x) => /^test\/\d+\/heartbeat$/.test(x))).toBe(true);
  });

  it("writes nothing new when the same snapshot arrives again", async () => {
    const sink = new RecordingSink();
    const p = new LiveProcessor(sink, { archive: false, root: "test" });
    const snapshot = messages.filter((m) => m?.kind === "snapshot").at(-1)!;
    await p.handle({ ...snapshot, force: true } as typeof snapshot);
    const dataWrites = () =>
      sink.paths().filter((x) => /\/(info|status|score|batsmen|bowlers|partnership|recent|balls\/\d+)$/.test(x)).length;
    const first = dataWrites();
    expect(first).toBeGreaterThan(0);
    await p.handle({ ...snapshot, force: true } as typeof snapshot); // exactly the same data again
    expect(dataWrites()).toBe(first);
    expect(p.stats.snapshots_unchanged).toBe(1);
  });

  it("drops repeated ball events", async () => {
    const sink = new RecordingSink();
    const p = new LiveProcessor(sink, { archive: false, root: "test" });
    const event = messages.find((m) => m?.kind === "ball_event");
    expect(event).toBeDefined();
    await p.handle(event!);
    await p.handle(event!);
    expect(p.stats.ball_events).toBe(1);
    expect(p.stats.ball_events_duplicate).toBe(1);
  });

  it("writes a match in full again after forgetMatch", async () => {
    const sink = new RecordingSink();
    const p = new LiveProcessor(sink, { archive: false, root: "test" });
    await feed(p, true);
    const matchId = messages.find((m) => m?.kind === "snapshot")!.matchId;
    const statusWrites = () => sink.paths().filter((x) => x === `test/${matchId}/status`).length;
    const before = statusWrites();
    p.forgetMatch(matchId);
    await feed(p, true);
    expect(statusWrites()).toBeGreaterThan(before);
  });
});
