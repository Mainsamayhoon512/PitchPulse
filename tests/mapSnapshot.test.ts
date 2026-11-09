import { describe, expect, it } from "vitest";
import { mapSnapshot } from "../src/live/mapSnapshot";
import { parseMessage } from "../src/live/parse";
import type { SnapshotMsg } from "../src/live/types";
import { fixtureMessages } from "./fixture";

const snapshots = fixtureMessages(400)
  .map((m) => parseMessage(m, Date.now()))
  .filter((m): m is SnapshotMsg => m?.kind === "snapshot");

describe("mapSnapshot", () => {
  it("has snapshots to test with", () => {
    expect(snapshots.length).toBeGreaterThan(10);
  });

  it("produces every Firebase section", () => {
    const mapped = mapSnapshot(snapshots[0].response, snapshots[0].matchId);
    expect(Object.keys(mapped.sections).sort()).toEqual(
      ["batsmen", "bowlers", "info", "partnership", "recent", "score", "status"].sort(),
    );
  });

  it("reads the competition id and a match update", () => {
    const mapped = mapSnapshot(snapshots[0].response, snapshots[0].matchId);
    expect(mapped.competitionProviderId).toEqual(expect.any(Number));
    expect(mapped.matchUpdate?.status).toEqual(expect.any(Number));
  });

  it("maps balls with the fields the app and the database need", () => {
    const withBalls = snapshots.map((s) => mapSnapshot(s.response, s.matchId)).find((m) => m.balls.length > 0);
    expect(withBalls).toBeDefined();
    for (const b of withBalls!.balls) {
      expect(b.eventId).toEqual(expect.any(Number));
      expect(["ball", "wicket"]).toContain(b.event);
      expect(b.wicket !== undefined).toBe(b.event === "wicket");
    }
  });

  it("never throws on an empty snapshot", () => {
    const mapped = mapSnapshot({}, 1);
    expect(mapped.balls).toEqual([]);
    expect(mapped.matchUpdate).toBeNull();
    expect(mapped.competitionProviderId).toBeNull();
  });
});
