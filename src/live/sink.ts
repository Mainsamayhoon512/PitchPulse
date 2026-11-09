import { readFileSync } from "node:fs";
import { initializeApp, cert, deleteApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

export interface LiveSink {
  /** Several paths in one write. A null value deletes that path. */
  update(values: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export class ConsoleSink implements LiveSink {
  constructor(private print = true) {}
  async update(values: Record<string, unknown>): Promise<void> {
    if (!this.print) return;
    const paths = Object.keys(values);
    const more = paths.length > 6 ? " ..." : "";
    console.log(`${new Date().toISOString()} SINK ${paths.length} path(s): ${paths.slice(0, 6).join(", ")}${more}`);
  }
  async close(): Promise<void> {}
}

// Firebase rejects undefined values, so everything goes through a JSON round trip.
const clean = (v: unknown): unknown => (v === null ? null : JSON.parse(JSON.stringify(v)));

export function createFirebaseSink(serviceAccountPath: string, databaseURL: string): LiveSink {
  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));
  const app = initializeApp({ credential: cert(serviceAccount), databaseURL });
  const db = getDatabase(app);
  return {
    async update(values) {
      const out: Record<string, unknown> = {};
      for (const [path, v] of Object.entries(values)) out[path] = clean(v);
      await db.ref().update(out);
    },
    async close() {
      await deleteApp(app);
    },
  };
}

export interface SinkCounts {
  calls: number;
  paths: number;
  bytes: number;
}

export function withCounts(inner: LiveSink): { sink: LiveSink; counts: SinkCounts } {
  const counts: SinkCounts = { calls: 0, paths: 0, bytes: 0 };
  const sink: LiveSink = {
    async update(values) {
      counts.calls++;
      counts.paths += Object.keys(values).length;
      counts.bytes += JSON.stringify(values).length;
      await inner.update(values);
    },
    close: () => inner.close(),
  };
  return { sink, counts };
}