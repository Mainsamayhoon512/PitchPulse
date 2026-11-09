import { obj, toInt, toStr } from "../sync/normalize";
import type { LiveMsg } from "./types";

function toMs(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n > 1e12 ? n : n * 1000;
}

export function parseMessage(raw: string, receivedAt: number): LiveMsg | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const m = obj(json);
  if (m.status !== undefined && m.status !== "ok") return null;
  const res = obj(m.response);

  if (m.api_type === "match_push_obj") {
    const matchId = toInt(res.match_id) ?? toInt(obj(res.match_info).match_id);
    if (matchId === null) return null;
    return { kind: "snapshot", matchId, providerTs: toMs(m.timestamp, receivedAt), response: res, receivedAt };
  }

  if (res.ball_event !== undefined) {
    const matchId = toInt(res.match_id);
    const code = toInt(res.code);
    if (matchId === null || code === null) return null;
    const d = obj(res.data);
    const [overPart] = String(d.over ?? "").split("."); // "9.3" is over 9, ball 3
    return {
      kind: "ball_event",
      matchId,
      code,
      label: toStr(res.ball_event) ?? "",
      over: toInt(overPart) ?? 0,
      ball: toInt(d.ball) ?? 0,
      inningsIid: toInt(d.iid),
      inningsNumber: toInt(d.inn_num),
      strikerId: toInt(d.striker_id),
      bowlerId: toInt(d.bowler_id),
      strikerName: toStr(d.striker_name),
      bowlerName: toStr(d.bowler_name),
      providerTs: toMs(m.timestamp, receivedAt),
      receivedAt,
    };
  }
  return null;
}