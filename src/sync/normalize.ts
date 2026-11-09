import type { Prisma } from "@prisma/client";
import type { Row } from "./merge";

export interface Normalized {
  providerId: number;
  data: Row;
}

// ---------- small helpers ----------

export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Numbers arrive as 6 or "6". Anything else becomes null. */
export function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

/** Trims text. Empty becomes null. */
export function toStr(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/** "1988-11-05" becomes a date. Junk such as "0000-00-00" becomes null. */
export function toDate(v: unknown): Date | null {
  const s = toStr(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "2023-01-18 08:00:00" (the provider's GMT times) becomes a UTC date. */
export function toUtcDateTime(v: unknown): Date | null {
  const s = toStr(v);
  if (!s || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return null;
  const d = new Date(`${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Keeps only real web links. Drops "@handles", plain names and Twitter login redirects. */
export function toUrl(v: unknown): string | null {
  const s = toStr(v);
  if (!s) return null;
  if (/\/login|redirect_after_login/i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

/** Stores JSON only when it has real content (the provider sends [] or objects of empty strings). */
function jsonOrUndefined(v: unknown): Prisma.InputJsonValue | undefined {
  if (Array.isArray(v)) return v.length > 0 ? (v as Prisma.InputJsonValue) : undefined;
  if (v && typeof v === "object") {
    const hasValue = Object.values(v).some((x) => x !== "" && x !== null && x !== undefined);
    return hasValue ? (v as Prisma.InputJsonValue) : undefined;
  }
  return undefined;
}

// ---------- competition ----------

export function normalizeCompetition(raw: unknown): Normalized | null {
  const r = obj(raw);
  const providerId = toInt(r.cid);
  const title = toStr(r.title);
  if (!providerId || !title) return null;
  return {
    providerId,
    data: {
      title,
      abbr: toStr(r.abbr),
      type: toStr(r.type),
      category: toStr(r.category),
      status: toStr(r.status), // live, fixture or result
      gameFormat: toStr(r.game_format ?? r.match_format),
      season: toStr(r.season),
      dateStart: toDate(r.datestart),
      dateEnd: toDate(r.dateend),
      country: toStr(r.country),
      totalMatches: toInt(r.total_matches),
      totalRounds: toInt(r.total_rounds),
      totalTeams: toInt(r.total_teams),
    },
  };
}

// ---------- team (handles tid/title, team_id/name and short_name variants) ----------

export function normalizeTeam(raw: unknown): Normalized | null {
  const r = obj(raw);
  const providerId = toInt(r.tid ?? r.team_id);
  const title = toStr(r.title ?? r.name);
  if (!providerId || !title) return null;
  return {
    providerId,
    data: {
      title,
      abbr: toStr(r.abbr ?? r.short_name),
      altName: toStr(r.alt_name),
      type: toStr(r.type),
      logoUrl: toUrl(r.logo_url),
      thumbUrl: toUrl(r.thumb_url),
      country: toStr(r.country ?? r.country_iso),
      sex: toStr(r.sex),
      teamOwner: toStr(r.team_owner),
      headCoach: toStr(r.head_coach),
    },
  };
}

// ---------- player ----------

export function normalizePlayer(raw: unknown): Normalized | null {
  const r = obj(raw);
  const providerId = toInt(r.pid);
  // first_name often holds the full name and last_name is empty, so title is the name to trust
  const title = toStr(r.title) ?? toStr(r.first_name);
  if (!providerId || !title) return null;
  return {
    providerId,
    data: {
      title,
      shortName: toStr(r.short_name),
      firstName: toStr(r.first_name),
      lastName: toStr(r.last_name),
      middleName: toStr(r.middle_name),
      birthdate: toDate(r.birthdate),
      birthplace: toStr(r.birthplace),
      country: toStr(r.country),
      nationality: toStr(r.nationality),
      logoUrl: toUrl(r.logo_url),
      playingRole: toStr(r.playing_role),
      battingStyle: toStr(r.batting_style),
      bowlingStyle: toStr(r.bowling_style),
      bowlingType: toStr(r.bowling_type),
      fieldingPosition: toStr(r.fielding_position),
      facebookUrl: toUrl(r.facebook_profile),
      twitterUrl: toUrl(r.twitter_profile),
      instagramUrl: toUrl(r.instagram_profile),
    },
  };
}

// ---------- venue (venue_list uses "city", matches use "location") ----------

export function normalizeVenue(raw: unknown): Normalized | null {
  const r = obj(raw);
  const providerId = toInt(r.venue_id);
  const name = toStr(r.name);
  if (!providerId || !name) return null;
  return {
    providerId,
    data: {
      name,
      city: toStr(r.city ?? r.location),
      country: toStr(r.country),
      capacity: toInt(r.capacity),
      // The provider's "timezone" field looked wrong (-12 for Indian cities), so it is ignored.
    },
  };
}

// ---------- round ----------

export interface NormalizedRound {
  rid: number;
  data: {
    name: string;
    order: number | null;
    type: string | null;
    matchFormat: string | null;
    dateStart: Date | null;
    dateEnd: Date | null;
  };
}

export function normalizeRound(raw: unknown): NormalizedRound | null {
  const r = obj(raw);
  const rid = toInt(r.rid);
  const name = toStr(r.name);
  if (!rid || !name) return null;
  return {
    rid,
    data: {
      name,
      order: toInt(r.order),
      type: toStr(r.type),
      matchFormat: toStr(r.match_format),
      dateStart: toDate(r.datestart),
      dateEnd: toDate(r.dateend),
    },
  };
}

// ---------- match ----------

export interface NormalizedMatch {
  matchId: number;
  teamA: Normalized | null;
  teamB: Normalized | null;
  venue: Normalized | null;
  data: {
    title: string;
    shortTitle: string | null;
    subtitle: string | null;
    matchNumber: string | null;
    format: number | null;
    formatStr: string | null;
    status: number | null;
    statusStr: string | null;
    statusNote: string | null;
    gameState: number | null;
    gameStateStr: string | null;
    domestic: boolean;
    teamAScore: string | null;
    teamBScore: string | null;
    dateStart: Date;
    dateEnd: Date | null;
    umpires: string | null;
    referee: string | null;
    result: string | null;
    resultType: number | null;
    winMargin: string | null;
    winningTeamProviderId: number | null;
    hasCommentary: boolean;
    hasWagon: boolean;
    latestInningNumber: number | null;
    toss: Prisma.InputJsonValue | undefined;
    pitch: Prisma.InputJsonValue | undefined;
    weather: Prisma.InputJsonValue | undefined;
  };
}

export function normalizeMatch(raw: unknown): NormalizedMatch | null {
  const r = obj(raw);
  const matchId = toInt(r.match_id);
  const startSec = toInt(r.timestamp_start);
  const endSec = toInt(r.timestamp_end);
  // timestamps are seconds in UTC; the text dates are GMT too and are the fallback
  const dateStart = startSec ? new Date(startSec * 1000) : toUtcDateTime(r.date_start);
  if (!matchId || !dateStart) return null;
  const a = obj(r.teama);
  const b = obj(r.teamb);
  return {
    matchId,
    teamA: normalizeTeam(a),
    teamB: normalizeTeam(b),
    venue: normalizeVenue(r.venue),
    data: {
      title: toStr(r.title) ?? "Unknown match",
      shortTitle: toStr(r.short_title),
      subtitle: toStr(r.subtitle),
      matchNumber: toStr(r.match_number),
      format: toInt(r.format),
      formatStr: toStr(r.format_str),
      status: toInt(r.status),
      statusStr: toStr(r.status_str),
      statusNote: toStr(r.status_note),
      gameState: toInt(r.game_state),
      gameStateStr: toStr(r.game_state_str),
      domestic: toBool(r.domestic),
      teamAScore: toStr(a.scores_full),
      teamBScore: toStr(b.scores_full),
      dateStart,
      dateEnd: endSec ? new Date(endSec * 1000) : toUtcDateTime(r.date_end),
      umpires: toStr(r.umpires),
      referee: toStr(r.referee),
      result: toStr(r.result),
      resultType: toInt(r.result_type),
      winMargin: toStr(r.win_margin),
      winningTeamProviderId: toInt(r.winning_team_id) || null, // 0 means nobody
      hasCommentary: toBool(r.commentary),
      hasWagon: toBool(r.wagon),
      latestInningNumber: toInt(r.latest_inning_number),
      toss: jsonOrUndefined(r.toss),
      pitch: jsonOrUndefined(r.pitch),
      weather: jsonOrUndefined(r.weather),
    },
  };
}