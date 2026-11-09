import WebSocket from "ws";
import { log } from "../logger";

export interface FeedHandlers {
  onMessage(raw: string, receivedAt: number): void;
  onOpen(isReconnect: boolean): void;
}

const SILENCE_RECONNECT_MS = 5 * 60_000; // no message at all for 5 minutes: treat the link as dead

export class Feed {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private stopping = false;
  private connectedBefore = false;
  private lastMessageAt = Date.now();
  private reconnectTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;

  constructor(
    private url: string,
    private handlers: FeedHandlers,
  ) {}

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.isOpen() && Date.now() - this.lastMessageAt > SILENCE_RECONNECT_MS) {
        log.warn("No messages for 5 minutes. Reconnecting");
        this.lastMessageAt = Date.now();
        this.socket?.terminate();
      }
    }, 30_000);
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.socket?.close();
  }

  private connect(): void {
    if (this.stopping) return;
    log.info(`Connecting to push feed (attempt ${this.attempt + 1})...`);
    const ws = new WebSocket(this.url);
    this.socket = ws;

    let heartbeat: NodeJS.Timeout | undefined;
    let awaitingPong = false;
    let everGotPong = false;

    ws.on("pong", () => {
      awaitingPong = false;
      everGotPong = true;
    });

    ws.on("open", () => {
      const reconnect = this.connectedBefore;
      this.connectedBefore = true;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      log.info(reconnect ? "Reconnected to push feed" : "Connected to push feed");
      this.handlers.onOpen(reconnect);
      heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Only enforce pongs if this server has ever answered one.
        if (awaitingPong && everGotPong) {
          log.warn("No pong received. Reconnecting");
          ws.terminate();
          return;
        }
        awaitingPong = true;
        ws.ping();
      }, 30_000);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      this.lastMessageAt = Date.now();
      this.handlers.onMessage(data.toString(), this.lastMessageAt);
    });

    ws.on("error", (err) => log.error("Socket error:", err.message));

    ws.on("close", (code) => {
      if (heartbeat) clearInterval(heartbeat);
      log.warn(`Connection closed (code ${code})`);
      if (this.stopping) return;
      const delay = Math.min(30_000, 1_000 * 2 ** this.attempt);
      this.attempt++;
      log.info(`Reconnecting in ${delay / 1000}s...`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }
}