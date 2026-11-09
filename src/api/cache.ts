import { log } from "../logger";
import { redis } from "../redis";

const inflight = new Map<string, Promise<unknown>>();

/**
 * Looks in Redis first. On a miss it runs `load`, stores the result for `ttl` seconds and returns it.
 * A null result is never stored. If Redis is down the API still works, just without the cache.
 * Two requests for the same key at the same moment share one database query.
 */
export async function cached<T>(
  key: string,
  ttl: number | ((value: T) => number),
  load: () => Promise<T | null>,
): Promise<T | null> {
  const k = `api:v1:${key}`;
  try {
    const hit = await redis.get(k);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (err) {
    log.warn("API cache read failed:", err);
  }

  const running = inflight.get(k) as Promise<T | null> | undefined;
  if (running) return running;

  const promise = (async () => {
    const value = await load();
    if (value !== null) {
      try {
        await redis.set(k, JSON.stringify(value), "EX", typeof ttl === "function" ? ttl(value) : ttl);
      } catch (err) {
        log.warn("API cache write failed:", err);
      }
    }
    return value;
  })().finally(() => inflight.delete(k));

  inflight.set(k, promise);
  return promise;
}

/** Same, for loaders that never return null (lists). */
export async function cachedValue<T>(key: string, ttl: number | ((value: T) => number), load: () => Promise<T>): Promise<T> {
  return (await cached<T>(key, ttl, load)) as T;
}