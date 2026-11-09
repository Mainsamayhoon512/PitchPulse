import { describe, expect, it } from "vitest";
import { parseMessage } from "../src/live/parse";
import { fixtureMessages } from "./fixture";

describe("parseMessage", () => {
  it("reads a ball event", () => {
    const raw = JSON.stringify({
      status: "ok",
      timestamp: 1793871843,
      response: { ball_event: "1", code: "35", match_id: "98955", data: { over: "9.3", ball: "3", iid: "216959", inn_num: "4", striker_name: "A", bowler_name: "B" } },
    });
    const msg = parseMessage(raw, 1);
    expect(msg).toMatchObject({ kind: "ball_event", matchId: 98955, code: 35, over: 9, ball: 3, inningsIid: 216959, inningsNumber: 4 });
    expect(msg?.providerTs).toBe(1793871843 * 1000); // seconds are converted to milliseconds
  });

  it("reads a snapshot", () => {
    const raw = JSON.stringify({ status: "ok", api_type: "match_push_obj", timestamp: 1793871843, response: { match_id: 98955 } });
    expect(parseMessage(raw, 1)).toMatchObject({ kind: "snapshot", matchId: 98955 });
  });

  it("ignores bad JSON, error replies and unknown messages", () => {
    expect(parseMessage("not json", 1)).toBeNull();
    expect(parseMessage(JSON.stringify({ status: "error" }), 1)).toBeNull();
    expect(parseMessage(JSON.stringify({ status: "ok", response: {} }), 1)).toBeNull();
  });

  it("understands every recorded message in the fixture", () => {
    const messages = fixtureMessages(400);
    expect(messages.length).toBe(400);
    expect(messages.filter((m) => parseMessage(m, 1) === null)).toHaveLength(0);
  });
});
