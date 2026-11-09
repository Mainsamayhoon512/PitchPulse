import { createHash } from "node:crypto";
import { log } from "../logger";
import { redis } from "../redis";
import { sleep } from "../utils";
import { bump, type Stats } from "../sync/stats";
import { archiveBalls, archiveInnings, archivePlayers, updateMatchStatus } from "./archive";
import { ballToFirebase, mapSnapshot, type BallRow, type InningsRow, type MappedSnapshot } from "./mapSnapshot";
import type { LiveSink } from "./sink";
import type { BallEventMsg, LiveMsg, SnapshotMsg } from "./types";
import { syncCompetition } from "../sync/orchestrator";


const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v) ?? "").digest("base64");
const HEARTBEAT_EVERY_MS = 30_000;

class LatencyTracker {
  private samples = new Map<string, number[]>();
  record(kind: string, ms: number) {
    const a = this.samples.get(kind) ?? [];
    a.push(ms);
    if (a.length > 1000) a.shift();
    this.samples.set(kind, a);
  }
  summary(): string {
    const parts: string[] = [];
    for (const [kind, a] of this.samples) {
      const s = [...a].sort((x, y) => x - y);
      const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
      parts.push(`${kind}: n=${s.length} p50=${p(0.5)}ms p95=${p(0.95)}ms max=${s[s.length - 1]}ms`);
    }
    return parts.join(" | ") || "no samples";
  }
}

export interface ProcessorOptions {
  archive: boolean; // write to Postgres
  cacheSnapshots?: boolean; // keep the latest snapshot per match in Redis for the API
  root?: string; // Firebase root path, "live" by default
}

export class LiveProcessor {
  readonly stats: Stats = {};
  readonly latency = new LatencyTracker();
  onMatchEnd?: (matchId: number) => void;

  private root: string;
  private sectionHashes = new Map<number, Map<string, string>>();
  private ballHashes = new Map<string, string>();
  private inningsHashes = new Map<number, string>();
  private lastApplied = new Map<number, number>();
  private lastEventKey = new Map<number, string>();
  private lastSeen = new Map<number, number>();
  private lastBeat = new Map<number, number>();
  private pending = new Map<number, SnapshotMsg>();
  private running = new Set<number>();
  private ballRows = new Map<string, BallRow>();
  private debugShown = 0;
  private ensureAt = new Map<number, number>();

  constructor(
    private sink: LiveSink,
    private opts: ProcessorOptions,
  ) {
    this.root = opts.root ?? "live";
  }

  activeMatchIds(maxAgeMs: number): number[] {
    const now = Date.now();
    return [...this.lastSeen].filter(([, t]) => now - t <= maxAgeMs).map(([id]) => id);
  }

  async drain(): Promise<void> {
    while (this.running.size > 0) await sleep(5);
  }

  async waitFor(matchId: number): Promise<void> {
    while (this.running.has(matchId)) await sleep(5);
  }

  async handle(msg: LiveMsg): Promise<void> {
    this.lastSeen.set(msg.matchId, Date.now());
    if (msg.kind === "ball_event") {
      await this.handleBallEvent(msg);
      return;
    }
    // Snapshots are full state, so only the newest one per match matters.
    if (this.pending.has(msg.matchId)) bump(this.stats, "snapshots_coalesced");
    this.pending.set(msg.matchId, msg);
    if (this.running.has(msg.matchId)) return;

    this.running.add(msg.matchId);
    try {
      while (this.pending.has(msg.matchId)) {
        const next = this.pending.get(msg.matchId) as SnapshotMsg;
        this.pending.delete(msg.matchId);
        try {
          await this.applySnapshot(next);
        } catch (err) {
          bump(this.stats, "snapshot_errors");
          log.error(`Snapshot for match ${msg.matchId} failed:`, err);
        }
      }
    } finally {
      this.running.delete(msg.matchId);
    }
  }

  // ---------- fast lane ----------

  private async handleBallEvent(msg: BallEventMsg): Promise<void> {
    const key = `${msg.inningsIid}|${msg.over}|${msg.ball}|${msg.code}`;
    if (this.lastEventKey.get(msg.matchId) === key) {
      bump(this.stats, "ball_events_duplicate"); // the provider repeats some events
      return;
    }
    this.lastEventKey.set(msg.matchId, key);
    bump(this.stats, "ball_events");
    try {
      await this.sink.update({
        [`${this.root}/${msg.matchId}/lastEvent`]: {
          code: msg.code,
          label: msg.label,
          innings: msg.inningsNumber,
          over: msg.over,
          ball: msg.ball,
          strikerName: msg.strikerName,
          bowlerName: msg.bowlerName,
          provisional: true, // confirmed by the next snapshot
          at: msg.receivedAt,
        },
      });
      this.latency.record("ball_event", Date.now() - msg.receivedAt);
    } catch (err) {
      bump(this.stats, "sink_errors");
      log.error("Ball event write failed:", err);
    }
    if (msg.code === 67) this.onMatchEnd?.(msg.matchId); // Match End: confirm over REST later
  }

  // ---------- truth lane ----------

  /** The match is not in the database yet because its series was never synced. Sync that series once, in the background. */
  private ensureMatch(matchId: number, cid: number | null): void {
    if (cid === null) return;
    if (Date.now() - (this.ensureAt.get(cid) ?? 0) < 30 * 60_000) return; // at most once per 30 minutes per series
    this.ensureAt.set(cid, Date.now());
    log.info(`Match ${matchId} is not in the database. Syncing competition ${cid}...`);
    syncCompetition(cid).then(
      () => log.info(`Competition ${cid} synced`),
      (err) => log.error(`Sync of competition ${cid} failed:`, err),
    );
  }

  private hashesFor(matchId: number): Map<string, string> {
    let m = this.sectionHashes.get(matchId);
    if (!m) {
      m = new Map();
      this.sectionHashes.set(matchId, m);
    }
    return m;
  }

  /** Which balls are new or changed. The hash is remembered only after a successful write. */
  private diffBalls(matchId: number, rows: BallRow[], commits: (() => void)[]) {
    //if (this.ballHashes.size > 200_000) this.ballHashes.clear();
    if (this.ballHashes.size > 200_000) {
      this.ballHashes.clear();
      this.ballRows.clear();
    }
    const changed: BallRow[] = [];
    const updates: Record<string, unknown> = {};
    for (const b of rows) {
      const key = `${matchId}:${b.eventId}`;
      // const h = hash(b);
      const h = hash({ ...b, providerTime: 0 });
      const old = this.ballHashes.get(key);
      if (old === h) continue;
      //if (old !== undefined) bump(this.stats, "ball_corrections");
      
      if (old !== undefined) {
        bump(this.stats, "ball_corrections");
        const prev = this.ballRows.get(key);
        if (prev && this.debugShown < 5) {
          this.debugShown++;
          const diffs = (Object.keys(b) as (keyof BallRow)[])
            .filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(b[k]))
            .map((k) => `${k}: ${JSON.stringify(prev[k])} -> ${JSON.stringify(b[k])}`);
          log.info(`Ball ${key} changed: ${diffs.join("; ")}`);
        }
      }

      changed.push(b);
      updates[`${this.root}/${matchId}/balls/${b.eventId}`] = ballToFirebase(b);
    //   commits.push(() => this.ballHashes.set(key, h));
        commits.push(() => {
            this.ballHashes.set(key, h);
            this.ballRows.set(key, b);
        });
    }
    return { changed, updates };
  }

  /** Used by gap filling: ball history fetched over REST. */
  async ingestBalls(matchId: number, rows: BallRow[]): Promise<number> {
    const commits: (() => void)[] = [];
    const { changed, updates } = this.diffBalls(matchId, rows, commits);
    if (changed.length === 0) return 0;
    await this.sink.update(updates);
    if (this.opts.archive) await archiveBalls(changed);
    commits.forEach((c) => c());
    return changed.length;
  }

  private async applySnapshot(msg: SnapshotMsg): Promise<void> {
    const { matchId } = msg;
    const last = this.lastApplied.get(matchId) ?? 0;
    if (!msg.force && msg.providerTs < last) {
      bump(this.stats, "snapshots_stale");
      return;
    }
    this.lastApplied.set(matchId, Math.max(last, msg.providerTs));

    const mapped = mapSnapshot(msg.response, matchId);
    const hashes = this.hashesFor(matchId);
    const sectionCommits: (() => void)[] = [];
    const ballCommits: (() => void)[] = [];
    const updates: Record<string, unknown> = {};

    for (const [name, value] of Object.entries(mapped.sections)) {
      const h = hash(value);
      if (hashes.get(name) === h) continue;
      updates[`${this.root}/${matchId}/${name}`] = value;
      sectionCommits.push(() => hashes.set(name, h));
    }
    const { changed, updates: ballUpdates } = this.diffBalls(matchId, mapped.balls, ballCommits);
    Object.assign(updates, ballUpdates);

    const hadChanges = Object.keys(updates).length > 0;
    const now = Date.now();
    if (now - (this.lastBeat.get(matchId) ?? 0) > HEARTBEAT_EVERY_MS) {
      updates[`${this.root}/${matchId}/heartbeat`] = now; // lets the app show "delayed" if it stops
      this.lastBeat.set(matchId, now);
    }

    try {
      await this.sink.update(updates);
      this.latency.record("snapshot", Date.now() - msg.receivedAt);
      bump(this.stats, "sink_writes");
    } catch (err) {
      bump(this.stats, "sink_errors");
      log.error(`Firebase write for match ${matchId} failed (will retry on the next snapshot):`, err);
      return;
    }
    sectionCommits.forEach((c) => c());
    bump(this.stats, hadChanges ? "snapshots_applied" : "snapshots_unchanged");

    if (this.opts.cacheSnapshots) {
      redis.set(`match:${matchId}:snapshot`, JSON.stringify(msg.response), "EX", 86_400).catch((e) => log.warn("Redis cache failed:", e));
      redis.set(`live:active:${matchId}`, "1", "EX", 1800).catch((e) => log.warn("Redis cache failed:", e));
    }
    if (this.opts.archive) {
      const ok = await this.archive(matchId, mapped, changed, hashes);
      if (!ok) return; // ball hashes stay uncommitted so the next snapshot retries
    }
    ballCommits.forEach((c) => c());
  }

  private async archive(
    matchId: number,
    mapped: MappedSnapshot,
    changedBalls: BallRow[],
    hashes: Map<string, string>,
  ): Promise<boolean> {
    try {
      if (changedBalls.length > 0) await archiveBalls(changedBalls);

      const changedInnings: { row: InningsRow; h: string }[] = [];
      for (const row of mapped.innings) {
        const h = hash(row);
        if (this.inningsHashes.get(row.iid) !== h) changedInnings.push({ row, h });
      }
      if (changedInnings.length > 0) {
        await archiveInnings(changedInnings.map((x) => x.row));
        changedInnings.forEach((x) => this.inningsHashes.set(x.row.iid, x.h));
      }

      if (mapped.matchUpdate) {
        const h = hash(mapped.matchUpdate);
        if (hashes.get("_match") !== h) {
          const updated = await updateMatchStatus(matchId, mapped.matchUpdate);
          if (updated > 0) hashes.set("_match", h);
          else this.ensureMatch(matchId, mapped.competitionProviderId);
        }
      }
      if (mapped.players.length > 0) {
        const h = hash(mapped.players);
        if (hashes.get("_players") !== h) {
          await archivePlayers(mapped.players);
          hashes.set("_players", h);
        }
      }
      return true;
    } catch (err) {
      bump(this.stats, "archive_errors");
      log.error(`Postgres write for match ${matchId} failed:`, err);
      return false;
    }
  }
}