import { config } from "../config";
import { redis } from "../redis";
import { log } from "../logger";
import { sleep } from "../utils";
import { acquire } from "./rateLimiter";

/** Shape every provider response shares. T is the type of the "response" part. */
export interface ProviderResponse<T> {
  status: string;
  response: T;
  etag?: string;
  modified?: string;
  datetime?: string;
  api_version?: string;
}

export interface ProviderResult<T> {
  body: ProviderResponse<T>;
  notModified: boolean; // true if the provider said "nothing changed" and we reused our copy
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean = false,
    public readonly httpStatus?: number,
    public readonly providerStatus?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

type Params = Record<string, string | number | undefined>;

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // keep our saved copy for 7 days

function buildUrl(path: string, params: Params): URL {
  const base = config.ENTITY_REST_BASE.replace(/\/$/, "");
  const url = new URL(`${base}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

export async function providerGet<T = unknown>(
  path: string,
  params: Params = {},
): Promise<ProviderResult<T>> {
  const url = buildUrl(path, params);

  // The cache key is built BEFORE the token is added, so the token is never stored.
  const label = `${url.pathname}${url.search}`;
  const cacheKey = `provider:cache:${label}`;
  const cachedRaw = await redis.get(cacheKey);
  const cached = cachedRaw ? (JSON.parse(cachedRaw) as ProviderResponse<T>) : null;

  url.searchParams.set("token", config.ENTITY_TOKEN);

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await acquire(config.PROVIDER_MAX_CALLS_PER_MINUTE);
      log.info(`GET ${label} (attempt ${attempt})`);

      const headers: Record<string, string> = { Accept: "application/json" };
      // Standard way to say "only send data if it changed since this version".
      // Whether this provider honours it is unverified; testConnection reports it.
      if (cached?.etag) headers["If-None-Match"] = cached.etag;

      const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });

      // Docs: 300 means "not modified". 304 is the standard code, so accept both.
      if (res.status === 300 || res.status === 304) {
        if (cached) return { body: cached, notModified: true };
        throw new ProviderError("Provider said 'not modified' but we have no saved copy", false, res.status);
      }
      if (res.status === 400 || res.status === 401) {
        throw new ProviderError(`HTTP ${res.status}: request rejected (check token and path)`, false, res.status);
      }
      if (res.status >= 500) {
        throw new ProviderError(`HTTP ${res.status}: provider server error`, true, res.status);
      }
      if (!res.ok) {
        throw new ProviderError(`Unexpected HTTP ${res.status}`, false, res.status);
      }

      const body = (await res.json()) as ProviderResponse<T>;

      // Docs: the body has its own status ("ok", "error", "unauthorized", "accessdenied").
      if (body.status !== "ok") {
        throw new ProviderError(`Provider status "${body.status}"`, false, res.status, body.status);
      }

      await redis.set(cacheKey, JSON.stringify(body), "EX", CACHE_TTL_SECONDS);
      return { body, notModified: false };
    } catch (err) {
      lastError = err;
      // Network errors and timeouts are retryable; ProviderError says for itself.
      const retryable = err instanceof ProviderError ? err.retryable : true;
      if (!retryable || attempt === MAX_ATTEMPTS) break;

      const delay = 500 * 2 ** (attempt - 1); // 0.5s, 1s, 2s...
      log.warn(`Call failed (${(err as Error).message}). Retrying in ${delay}ms`);
      await sleep(delay);
    }
  }

  throw lastError;
}