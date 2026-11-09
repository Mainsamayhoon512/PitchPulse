export interface BallEventMsg {
  kind: "ball_event";
  matchId: number;
  code: number;
  label: string;
  over: number;
  ball: number;
  inningsIid: number | null;
  inningsNumber: number | null;
  strikerId: number | null;
  bowlerId: number | null;
  strikerName: string | null;
  bowlerName: string | null;
  providerTs: number; // ms
  receivedAt: number; // ms, when our socket got it
}

export interface SnapshotMsg {
  kind: "snapshot";
  matchId: number;
  providerTs: number; // ms
  response: Record<string, unknown>;
  receivedAt: number;
  force?: boolean; // true for data we fetched ourselves over REST (never rejected as stale)
}

export type LiveMsg = BallEventMsg | SnapshotMsg;