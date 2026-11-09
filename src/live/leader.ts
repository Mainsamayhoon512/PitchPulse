import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { log } from "../logger";
import { redis } from "../redis";

const KEY = "live:leader";
const TTL_MS = 15_000;
const TICK_MS = 5_000;

// Renew the lock only if it is still ours.
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export class Leader {
  readonly id = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  onElected?: () => void;
  private leader = false;
  private timer?: NodeJS.Timeout;

  isLeader(): boolean {
    return this.leader;
  }

  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  private async tick(): Promise<void> {
    try {
      let holds = (await redis.set(KEY, this.id, "PX", TTL_MS, "NX")) === "OK";
      if (!holds) holds = (await redis.eval(RENEW, 1, KEY, this.id, String(TTL_MS))) === 1;
      if (holds && !this.leader) {
        this.leader = true;
        log.info(`This instance (${this.id}) is now the LEADER`);
        this.onElected?.();
      } else if (!holds && this.leader) {
        this.leader = false;
        log.warn("Lost leadership. Now standing by");
      }
    } catch (err) {
      // Keep the current state. Two leaders for a moment are harmless because writes are idempotent.
      log.error("Leader check failed:", err);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    try {
      await redis.eval(RELEASE, 1, KEY, this.id);
    } catch {
      // ignore
    }
    this.leader = false;
  }
}