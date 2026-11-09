import type { Prisma } from "@prisma/client";
import { list, obj, toBool, toInt, toStr } from "../sync/normalize";

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

export interface BallRow {
  matchId: number;
  eventId: number;
  inningsIid: number;
  inningsNumber: number | null;
  over: number;
  ball: number;
  event: string;
  batsmanProviderId: number | null;
  bowlerProviderId: number | null;
  score: string;
  runs: number;
  batRun: number;
  wideRun: number;
  noballRun: number;
  byeRun: number;
  legbyeRun: number;
  isFour: boolean;
  isSix: boolean;
  isFreehit: boolean;
  commentary: string | null;
  wicket: Prisma.InputJsonValue | undefined;
  wagon: Prisma.InputJsonValue | undefined;
  providerTime: Date;
}

export interface InningsRow {
  iid: number;
  matchId: number;
  number: number;
  name: string | null;
  shortName: string | null;
  status: number | null;
  result: number | null;
  battingTeamProviderId: number | null;
  fieldingTeamProviderId: number | null;
  scores: string | null;
  scoresFull: string | null;
  scorecard: Prisma.InputJsonValue | undefined;
}

export interface MatchUpdate {
  status: number | null;
  statusStr: string | null;
  statusNote: string | null;
  gameState: number | null;
  gameStateStr: string | null;
  teamAScore: string | null;
  teamBScore: string | null;
  result: string | null;
  resultType: number | null;
  winMargin: string | null;
  winningTeamProviderId: number | null;
  latestInningNumber: number | null;
}

export interface MappedSnapshot {
  sections: Record<string, unknown>; // name -> value, stored at live/{matchId}/{name}
  balls: BallRow[];
  innings: InningsRow[];
  matchUpdate: MatchUpdate | null;
  players: unknown[];
  competitionProviderId: number | null;
}

/** One delivery. Works for snapshot commentary and for the REST innings commentary. */
export function mapBall(raw: unknown, matchId: number, iid: number, inningsNumber: number | null): BallRow | null {
  const r = obj(raw);
  const event = toStr(r.event);
  const eventId = toInt(r.event_id);
  const over = toInt(r.over);
  const ball = toInt(r.ball);
  if ((event !== "ball" && event !== "wicket") || eventId === null || over === null || ball === null) return null;

  const w = obj(r.wagon);
  const hasWagon = (toInt(w.x) ?? 0) !== 0 || (toInt(w.y) ?? 0) !== 0 || (toInt(w.z) ?? 0) !== 0;
  const ts = toInt(r.timestamp) ?? Math.floor(Date.now() / 1000);

  return {
    matchId,
    eventId,
    inningsIid: iid,
    inningsNumber,
    over,
    ball,
    event,
    batsmanProviderId: toInt(r.batsman_id),
    bowlerProviderId: toInt(r.bowler_id),
    score: String(r.score ?? ""), // a number, "w", "1wd", "2lb" ...
    runs: toInt(r.run) ?? 0,
    batRun: toInt(r.bat_run) ?? 0,
    wideRun: toInt(r.wide_run) ?? 0,
    noballRun: toInt(r.noball_run) ?? 0,
    byeRun: toInt(r.bye_run) ?? 0,
    legbyeRun: toInt(r.legbye_run) ?? 0,
    isFour: toBool(r.four),
    isSix: toBool(r.six),
    isFreehit: toBool(r.freehit),
    commentary: toStr(r.commentary),
    wicket:
      event === "wicket"
        ? {
            wicketBatsmanId: toInt(r.wicket_batsman_id),
            howOut: toStr(r.how_out),
            dismissal: toStr(r.dismissal),
            batsmanRuns: toInt(r.batsman_runs),
            batsmanBalls: toInt(r.batsman_balls),
          }
        : undefined,
    wagon: hasWagon ? (w as Prisma.InputJsonValue) : undefined,
    providerTime: new Date(ts * 1000),
  };
}

/** What the app sees for one ball at live/{matchId}/balls/{eventId}. */
export function ballToFirebase(b: BallRow) {
  return {
    innings: b.inningsNumber,
    over: b.over,
    ball: b.ball,
    event: b.event,
    score: b.score,
    runs: b.runs,
    batRun: b.batRun,
    wide: b.wideRun,
    noBall: b.noballRun,
    bye: b.byeRun,
    legBye: b.legbyeRun,
    four: b.isFour,
    six: b.isSix,
    freeHit: b.isFreehit,
    batsmanId: b.batsmanProviderId,
    bowlerId: b.bowlerProviderId,
    commentary: b.commentary,
    wicket: b.wicket ?? null,
    time: b.providerTime.getTime(),
  };
}

export function mapSnapshot(response: Record<string, unknown>, matchId: number): MappedSnapshot {
  const mi = obj(response.match_info);
  const live = obj(response.live);
  const ls = obj(live.live_score);
  const li = obj(live.live_inning);
  const a = obj(mi.teama);
  const b = obj(mi.teamb);
  const liveIid = toInt(li.iid);
  const liveNumber = toInt(live.live_inning_number) ?? toInt(li.number);
  const partnership = obj(li.current_partnership);

  const sections: Record<string, unknown> = {
    // changes rarely
    info: {
      title: toStr(mi.title),
      shortTitle: toStr(mi.short_title),
      subtitle: toStr(mi.subtitle),
      format: toStr(mi.format_str),
      competition: { id: toInt(obj(mi.competition).cid), title: toStr(obj(mi.competition).title) },
      teamA: { id: toInt(a.team_id), name: toStr(a.name), short: toStr(a.short_name), logo: toStr(a.logo_url) },
      teamB: { id: toInt(b.team_id), name: toStr(b.name), short: toStr(b.short_name), logo: toStr(b.logo_url) },
      venue: { name: toStr(obj(mi.venue).name), city: toStr(obj(mi.venue).location) },
      toss: toStr(obj(mi.toss).text),
      startsAt: toInt(mi.timestamp_start),
    },
    status: {
      status: toInt(mi.status),
      statusStr: toStr(mi.status_str),
      statusNote: toStr(live.status_note) ?? toStr(mi.status_note),
      gameState: toInt(mi.game_state),
      gameStateStr: toStr(mi.game_state_str),
      day: toStr(mi.day),
      session: toStr(mi.session),
      teamBatting: toStr(live.team_batting),
      teamBowling: toStr(live.team_bowling),
      inning: liveNumber,
      result: toStr(mi.result),
      winningTeamId: toInt(mi.winning_team_id) || null,
    },
    score: {
      runs: num(ls.runs),
      wickets: num(ls.wickets),
      overs: num(ls.overs),
      target: num(ls.target),
      runRate: num(ls.runrate),
      requiredRunRate: num(ls.required_runrate),
      inningsScore: toStr(li.scores_full),
      battingTeamId: toInt(li.batting_team_id),
      teamA: { id: toInt(a.team_id), score: toStr(a.scores_full) },
      teamB: { id: toInt(b.team_id), score: toStr(b.scores_full) },
      equation: toStr(mi.equation),
    },
    batsmen: list(live.batsmen).map((x) => {
      const p = obj(x);
      return {
        id: toInt(p.batsman_id),
        name: toStr(p.name),
        runs: num(p.runs),
        balls: num(p.balls_faced),
        fours: num(p.fours),
        sixes: num(p.sixes),
        strikeRate: toStr(p.strike_rate),
      };
    }),
    bowlers: list(live.bowlers).map((x) => {
      const p = obj(x);
      return {
        id: toInt(p.bowler_id),
        name: toStr(p.name),
        overs: num(p.overs),
        maidens: num(p.maidens),
        runs: num(p.runs_conceded),
        wickets: num(p.wickets),
        economy: toStr(p.econ),
      };
    }),
    partnership: {
      runs: num(partnership.runs),
      balls: num(partnership.balls),
      overs: num(partnership.overs),
      batsmen: list(partnership.batsmen),
    },
    recent: {
      recentScores: toStr(li.recent_scores),
      lastFiveOvers: toStr(li.last_five_overs),
      lastTenOvers: toStr(li.last_ten_overs),
      lastWicket: li.last_wicket ?? null,
    },
  };

  // Balls in the snapshot's rolling window belong to the live innings.
  const balls: BallRow[] = [];
  if (liveIid !== null) {
    for (const c of list(live.commentaries)) {
      const row = mapBall(c, matchId, liveIid, liveNumber);
      if (row) balls.push(row);
    }
  }

  const innings: InningsRow[] = [];
  for (const raw of list(obj(response.scorecard).innings)) {
    const i = obj(raw);
    const iid = toInt(i.iid);
    const number = toInt(i.number);
    if (iid === null || number === null) continue;
    const status = toInt(i.status);
    innings.push({
      iid,
      matchId,
      number,
      name: toStr(i.name),
      shortName: toStr(i.short_name),
      status,
      result: toInt(i.result),
      battingTeamProviderId: toInt(i.batting_team_id),
      fieldingTeamProviderId: toInt(i.fielding_team_id),
      scores: toStr(i.scores),
      scoresFull: toStr(i.scores_full),
      scorecard: status === 2 ? (i as Prisma.InputJsonValue) : undefined, // full scorecard once completed
    });
  }

  const status = toInt(mi.status);
  const matchUpdate: MatchUpdate | null =
    status === null
      ? null
      : {
          status,
          statusStr: toStr(mi.status_str),
          statusNote: toStr(mi.status_note),
          gameState: toInt(mi.game_state),
          gameStateStr: toStr(mi.game_state_str),
          teamAScore: toStr(a.scores_full),
          teamBScore: toStr(b.scores_full),
          result: toStr(mi.result),
          resultType: toInt(mi.result_type),
          winMargin: toStr(mi.win_margin),
          winningTeamProviderId: toInt(mi.winning_team_id) || null,
          latestInningNumber: toInt(mi.latest_inning_number),
        };

  return {
    sections,
    balls,
    innings,
    matchUpdate,
    players: list(response.players),
    competitionProviderId: toInt(obj(mi.competition).cid),
  };
}