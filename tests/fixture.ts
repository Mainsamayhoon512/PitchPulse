import { readFileSync } from "node:fs";

/** The first `count` recorded provider messages, as raw JSON strings (what the socket would deliver). */
export function fixtureMessages(count: number): string[] {
  return readFileSync("fixtures/live-sample.ndjson", "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(0, count)
    .map((line) => JSON.stringify((JSON.parse(line) as { payload: unknown }).payload));
}
