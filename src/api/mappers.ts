import type { Ball, Competition, Innings, Match, Player, Round, Team, Venue } from "@prisma/client";

export const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

export const team = (t: Team) => ({
  id: t.id,
  providerId: t.providerId,
  name: t.title,
  short: t.abbr,
  type: t.type,
  country: t.country,
  logo: t.logoUrl ?? t.thumbUrl,
});

export const teamDetail = (t: Team) => ({
  ...team(t),
  altName: t.altName,
  sex: t.sex,
  headCoach: t.headCoach,
  owner: t.teamOwner,
});

export const venue = (v: Venue) => ({
  id: v.id,
  providerId: v.providerId,
  name: v.name,
  city: v.city,
  country: v.country,
  capacity: v.capacity,
});

export const competition = (c: Competition) => ({
  id: c.id,
  providerId: c.providerId,
  title: c.title,
  short: c.abbr,
  type: c.type,
  category: c.category,
  status: c.status,
  format: c.gameFormat,
  season: c.season,
  startDate: day(c.dateStart),
  endDate: day(c.dateEnd),
  country: c.country,
  totalMatches: c.totalMatches,
  totalTeams: c.totalTeams,
});

export const round = (r: Round) => ({
  id: r.rid,
  name: r.name,
  order: r.order,
  type: r.type,
  format: r.matchFormat,
  startDate: day(r.dateStart),
  endDate: day(r.dateEnd),
});

export const playerSummary = (p: Player) => ({
  id: p.id,
  providerId: p.providerId,
  name: p.title,
  role: p.playingRole,
  country: p.country,
  image: p.photoUrl ?? p.logoUrl,
});

export const playerDetail = (p: Player) => ({
  ...playerSummary(p),
  shortName: p.shortName,
  firstName: p.firstName,
  lastName: p.lastName,
  birthdate: day(p.birthdate),
  birthplace: p.birthplace,
  nationality: p.nationality,
  battingStyle: p.battingStyle,
  bowlingStyle: p.bowlingStyle,
  bowlingType: p.bowlingType,
  fieldingPosition: p.fieldingPosition,
  bio: p.bio,
  social: { facebook: p.facebookUrl, twitter: p.twitterUrl, instagram: p.instagramUrl },
});

type MatchWith = Match & {
  teamA: Team | null;
  teamB: Team | null;
  venue: Venue | null;
  competition: Competition | null;
};

export const matchSummary = (m: MatchWith) => {
  const winner =
    m.winningTeamProviderId === null
      ? null
      : m.winningTeamProviderId === m.teamA?.providerId
        ? "teamA"
        : m.winningTeamProviderId === m.teamB?.providerId
          ? "teamB"
          : null;
  return {
    id: m.matchId, // the provider's match id, also used in Firebase
    title: m.title,
    shortTitle: m.shortTitle,
    subtitle: m.subtitle,
    matchNumber: m.matchNumber,
    format: { code: m.format, name: m.formatStr },
    status: { code: m.status, name: m.statusStr, note: m.statusNote },
    live: m.status === 3,
    startsAt: m.dateStart,
    teamA: m.teamA ? { ...team(m.teamA), score: m.teamAScore } : null,
    teamB: m.teamB ? { ...team(m.teamB), score: m.teamBScore } : null,
    venue: m.venue ? { id: m.venue.id, name: m.venue.name, city: m.venue.city } : null,
    competition: m.competition ? { id: m.competition.id, providerId: m.competition.providerId, title: m.competition.title } : null,
    result: m.result,
    winner,
  };
};

export const matchDetail = (m: MatchWith) => ({
  ...matchSummary(m),
  endsAt: m.dateEnd,
  gameState: { code: m.gameState, name: m.gameStateStr },
  resultType: m.resultType,
  winMargin: m.winMargin,
  winningTeamProviderId: m.winningTeamProviderId,
  toss: m.toss,
  pitch: m.pitch,
  weather: m.weather,
  umpires: m.umpires,
  referee: m.referee,
  domestic: m.domestic,
  hasCommentary: m.hasCommentary,
  hasWagon: m.hasWagon,
  latestInningNumber: m.latestInningNumber,
  liveRef: m.status === 3 ? `live/${m.matchId}` : null, // where the live data is in Firebase
});

export const innings = (i: Innings) => ({
  id: i.iid,
  number: i.number,
  name: i.name,
  short: i.shortName,
  status: i.status,
  result: i.result,
  battingTeamProviderId: i.battingTeamProviderId,
  fieldingTeamProviderId: i.fieldingTeamProviderId,
  scores: i.scores,
  scoresFull: i.scoresFull,
  scorecard: i.scorecard, // full scorecard, present once the innings is completed
});

export type PlayerNames = Map<number, { id: number; name: string }>;

export const ball = (b: Ball, names: PlayerNames) => ({
  eventId: b.eventId,
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
  batsman: b.batsmanProviderId === null ? null : { providerId: b.batsmanProviderId, ...names.get(b.batsmanProviderId) },
  bowler: b.bowlerProviderId === null ? null : { providerId: b.bowlerProviderId, ...names.get(b.bowlerProviderId) },
  commentary: b.commentary,
  wicket: b.wicket,
  wagon: b.wagon,
  time: b.providerTime,
});