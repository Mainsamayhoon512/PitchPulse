import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { config } from "../config";
import { log } from "../logger";

mkdirSync(config.CAPTURE_DIR, { recursive: true });

const url = `${config.ENTITY_WS_URL}?token=${config.ENTITY_TOKEN}`;

let socket: WebSocket | null = null;
let attempt = 0;
let stopping = false;
let messageCount = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

function captureFile(): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(config.CAPTURE_DIR, `push-${day}.ndjson`);
}

function saveMessage(raw: string) {
  let payload: unknown = raw;
  let parsed = false;
  try {
    payload = JSON.parse(raw);
    parsed = true;
  } catch {
    // not JSON: keep the raw text
  }
  const line = JSON.stringify({
    receivedAtMs: Date.now(), // lets us measure delay against the ball's own timestamp later
    receivedAt: new Date().toISOString(),
    parsed,
    payload,
  });
  appendFileSync(captureFile(), line + "\n");
}

function connect() {
  if (stopping) return;
  log.info(`Connecting to push feed (attempt ${attempt + 1})...`);

  const ws = new WebSocket(url);
  socket = ws;

  // Heartbeat: ping every 30s. If the server used to answer and stops, the link is dead.
  let heartbeat: NodeJS.Timeout | undefined;
  let awaitingPong = false;
  let everGotPong = false;
  let missedPings = 0;

  ws.on("pong", () => {
    awaitingPong = false;
    everGotPong = true;
    missedPings = 0;
  });

  ws.on("open", () => {
    log.info("Connected. Waiting for messages (quiet periods are normal when no match is live).");
    attempt = 0;
    heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (awaitingPong) {
        missedPings++;
        if (everGotPong) {
          log.warn("No pong received: connection looks dead. Reconnecting.");
          ws.terminate();
          return;
        }
        if (missedPings === 3) {
          log.warn("Server never answers pings. Heartbeat check disabled for this connection.");
        }
      }
      awaitingPong = true;
      ws.ping();
    }, 30_000);
  });

  ws.on("message", (data: WebSocket.RawData) => {
    const raw = data.toString();
    messageCount++;
    saveMessage(raw);
    const preview = raw.length > 200 ? raw.slice(0, 200) + "..." : raw;
    log.info(`#${messageCount} (${raw.length} bytes) ${preview}`);
  });

  ws.on("error", (err) => log.error("Socket error:", err.message));

  ws.on("close", (code, reason) => {
    if (heartbeat) clearInterval(heartbeat);
    const why = reason.length ? `, ${reason.toString()}` : "";
    log.warn(`Connection closed (code ${code}${why})`);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (stopping) return;
  const delay = Math.min(30_000, 1_000 * 2 ** attempt); // 1s, 2s, 4s... max 30s
  attempt++;
  log.info(`Reconnecting in ${delay / 1000}s...`);
  reconnectTimer = setTimeout(connect, delay);
}

// A status line every minute so you know it is alive even when nothing arrives.
const statusTimer = setInterval(() => {
  const state = socket?.readyState === WebSocket.OPEN ? "connected" : "not connected";
  log.info(`Status: ${state}, ${messageCount} message(s) captured so far`);
}, 60_000);

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  clearInterval(statusTimer);
  log.info(`Stopping. ${messageCount} message(s) captured.`);
  socket?.close();
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

connect();