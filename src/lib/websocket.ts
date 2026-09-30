import type { Server as HttpServer, IncomingMessage } from "http";
import { URL } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { timingSafeCompare } from "./timing-safe";
import { vaultEventEmitter, VAULT_EVENT, type VaultEvent } from "./vaultEvents";
import { logger } from "./logger";

export interface ScoreUpdate {
  project_id: number;
  credit_quality: number;
  green_impact: number;
  timestamp: number; // Unix ms
}

// Binary protocol message types (first byte of every binary frame).
const MSG_SCORE_UPDATE = 0x01;

interface ClientState {
  // Project ids this connection wants updates for. The `all` flag overrides
  // the set and streams every project.
  subscriptions: Set<number>;
  all: boolean;
}

const clients = new Map<WebSocket, ClientState>();
let wss: WebSocketServer | null = null;

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Encode a score update into a compact 15-byte binary frame. Sending the raw
 * numbers (rather than JSON) keeps each update tiny and cheap to parse:
 *   [0]      message type   uint8   (0x01 = score update)
 *   [1..4]   project_id     uint32  BE
 *   [5]      credit_quality uint8   (0–100)
 *   [6]      green_impact   uint8   (0–100)
 *   [7..14]  timestamp ms   float64 BE
 */
export function encodeScoreUpdate(update: ScoreUpdate): Buffer {
  const buf = Buffer.allocUnsafe(15);
  buf.writeUInt8(MSG_SCORE_UPDATE, 0);
  buf.writeUInt32BE(update.project_id, 1);
  buf.writeUInt8(clampByte(update.credit_quality), 5);
  buf.writeUInt8(clampByte(update.green_impact), 6);
  buf.writeDoubleBE(update.timestamp, 7);
  return buf;
}

/**
 * Authenticate an incoming upgrade request. The token must be supplied as an
 * `Authorization: Bearer <token>` header. It is deliberately not accepted as a
 * `?token=` query parameter: query strings routinely leak into access logs,
 * reverse-proxy/CDN logs, browser history, and Referer headers.
 *
 * Auth requires a dedicated WS_AUTH_TOKEN and never falls back to ADMIN_API_KEY
 * — that key gates every admin REST endpoint and must not be reachable over the
 * WebSocket upgrade path. When WS_AUTH_TOKEN is unset the connection is refused
 * in production and allowed elsewhere (dev/test only).
 */
export function authenticate(req: IncomingMessage): boolean {
  const expected = process.env.WS_AUTH_TOKEN;
  if (!expected) {
    return (process.env.NODE_ENV || "development").toLowerCase() !== "production";
  }
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  return token !== undefined && timingSafeCompare(token, expected);
}

function asIdArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is number => Number.isInteger(n) && (n as number) >= 1);
}

function sendError(ws: WebSocket, message: string): void {
  ws.send(JSON.stringify({ type: "error", message }));
}

function handleMessage(ws: WebSocket, data: unknown): void {
  const state = clients.get(ws);
  if (!state) return;

  let msg: { action?: string; project_ids?: unknown; all?: boolean };
  try {
    msg = JSON.parse(String(data));
  } catch {
    return sendError(ws, "invalid JSON control frame");
  }

  switch (msg.action) {
    case "subscribe":
      if (msg.all === true || msg.project_ids === "all") {
        state.all = true;
      } else {
        for (const id of asIdArray(msg.project_ids)) state.subscriptions.add(id);
      }
      break;
    case "unsubscribe":
      if (msg.all === true || msg.project_ids === "all") {
        state.all = false;
        state.subscriptions.clear();
      } else {
        for (const id of asIdArray(msg.project_ids)) state.subscriptions.delete(id);
      }
      break;
    default:
      return sendError(ws, `unknown action: ${String(msg.action)}`);
  }

  ws.send(
    JSON.stringify({
      type: "subscribed",
      all: state.all,
      project_ids: Array.from(state.subscriptions),
    }),
  );
}

// ── Public browser event stream (#767) ───────────────────────────────────────
//
// The frontend opens `new WebSocket(url + "/ws/events")` with no headers,
// so this endpoint MUST NOT require the `Authorization: Bearer` gate used
// by the admin `/ws` binary feed above. It streams JSON `VaultEvent`
// frames (see `./vaultEvents.ts`) and applies per-IP connection limits +
// a heartbeat so browser tabs stuck behind sleep or NAT timeout are
// cleaned up.
//
// Both servers share the same underlying HTTP upgrade event to avoid
// path-collision issues that arise when two `WebSocketServer`s both
// register their own `upgrade` listener. We route by URL pathname
// centrally in `attachWebSocketServer`.

interface EventsClientState {
  ip: string;
  /** Contract filter set via `?contract=<id>` on the WebSocket URL. */
  contractId: string | null;
  /** Last time the client answered our ping, used to drop stale sockets. */
  lastPongAt: number;
}

const eventsClients = new Map<WebSocket, EventsClientState>();
const eventsIpCounts = new Map<string, number>();
let eventsWss: WebSocketServer | null = null;
let eventsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let vaultEventListener: ((evt: VaultEvent) => void) | null = null;

const WS_EVENTS_PATH = "/ws/events";
const WS_EVENTS_MAX_PER_IP_DEFAULT = 8;
const WS_EVENTS_HEARTBEAT_MS = 30_000;
const WS_EVENTS_PONG_TIMEOUT_MS = 60_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ipFromRequest(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    const first = fwd.split(",")[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function contractFromRequest(req: IncomingMessage): string | null {
  if (!req.url) return null;
  try {
    const parsed = new URL(req.url, "http://placeholder.local");
    const value = parsed.searchParams.get("contract");
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function attachEventsListener(): void {
  if (vaultEventListener) return;
  vaultEventListener = (evt: VaultEvent): void => {
    if (!eventsWss) return;
    const frame = JSON.stringify(evt);
    for (const [ws, state] of eventsClients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (state.contractId !== null && state.contractId !== evt.contractId) continue;
      ws.send(frame);
    }
  };
  vaultEventEmitter.on(VAULT_EVENT, vaultEventListener);
}

function startHeartbeat(): void {
  if (eventsHeartbeatTimer) return;
  eventsHeartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [ws, state] of eventsClients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (now - state.lastPongAt > WS_EVENTS_PONG_TIMEOUT_MS) {
        try {
          ws.terminate();
        } catch {
          // ignore, socket may already be closing
        }
        continue;
      }
      try {
        ws.ping();
      } catch {
        // ignore transient send errors; the next tick will re-check state
      }
    }
  }, WS_EVENTS_HEARTBEAT_MS);
  // Do not block process exit on the heartbeat.
  eventsHeartbeatTimer.unref?.();
}

/**
 * Attach the browser-facing vault event stream. Idempotent: safe to call
 * more than once, but only the first call actually wires anything up.
 * Callers do not need to invoke this directly if they use
 * `attachWebSocketServer` below, which sets both feeds up together.
 */
export function attachEventsWebSocketServer(server: HttpServer): WebSocketServer {
  if (eventsWss) return eventsWss;

  const maxPerIp = envInt("WS_EVENTS_MAX_PER_IP", WS_EVENTS_MAX_PER_IP_DEFAULT);

  eventsWss = new WebSocketServer({ noServer: true });

  eventsWss.on("connection", (ws, req) => {
    const ip = ipFromRequest(req);
    const currentCount = eventsIpCounts.get(ip) ?? 0;
    if (currentCount >= maxPerIp) {
      try {
        ws.close(1013, "too many connections from this IP");
      } catch {
        // ignore
      }
      return;
    }
    eventsIpCounts.set(ip, currentCount + 1);
    eventsClients.set(ws, {
      ip,
      contractId: contractFromRequest(req),
      lastPongAt: Date.now(),
    });

    ws.on("pong", () => {
      const state = eventsClients.get(ws);
      if (state) state.lastPongAt = Date.now();
    });
    const cleanup = () => {
      if (!eventsClients.has(ws)) return;
      eventsClients.delete(ws);
      const next = (eventsIpCounts.get(ip) ?? 1) - 1;
      if (next <= 0) eventsIpCounts.delete(ip);
      else eventsIpCounts.set(ip, next);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  attachEventsListener();
  startHeartbeat();

  return eventsWss;
}

/**
 * Test-only reset hook: terminates every open WebSocket, clears in-memory
 * client state, stops the heartbeat, unregisters the vault listener, and
 * closes both `WebSocketServer` instances so jest / bun test can exit the
 * event loop cleanly between test files.
 */
export function _resetEventsServerForTests(): void {
  for (const ws of eventsClients.keys()) {
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  }
  eventsClients.clear();
  eventsIpCounts.clear();
  if (eventsHeartbeatTimer) {
    clearInterval(eventsHeartbeatTimer);
    eventsHeartbeatTimer = null;
  }
  if (vaultEventListener) {
    vaultEventEmitter.off(VAULT_EVENT, vaultEventListener);
    vaultEventListener = null;
  }
  if (eventsWss) {
    try {
      eventsWss.close();
    } catch {
      // ignore
    }
    eventsWss = null;
  }
  for (const ws of clients.keys()) {
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  }
  clients.clear();
  if (wss) {
    try {
      wss.close();
    } catch {
      // ignore
    }
    wss = null;
  }
}

/**
 * Attach both WebSocket feeds to an existing HTTP server:
 *
 * - `/ws`: authenticated binary score-update stream (unchanged).
 * - `/ws/events`: public JSON vault event stream for browser clients.
 *
 * The server's `upgrade` event is dispatched by URL pathname so both feeds
 * can coexist without one server's registration clobbering the other's.
 */
export function attachWebSocketServer(server: HttpServer): WebSocketServer {
  wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    clients.set(ws, { subscriptions: new Set(), all: false });
    ws.on("message", (data) => handleMessage(ws, data));
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  const events = attachEventsWebSocketServer(server);

  server.on("upgrade", (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://placeholder.local").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === WS_EVENTS_PATH) {
      events.handleUpgrade(req, socket, head, (ws) => {
        events.emit("connection", ws, req);
      });
      return;
    }
    if (pathname === "/ws") {
      if (!authenticate(req)) {
        // Emit a proper HTTP 401 rather than a bare socket close so
        // debugging clients see something actionable.
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss!.handleUpgrade(req, socket, head, (ws) => {
        wss!.emit("connection", ws, req);
      });
      return;
    }
    // Not a WebSocket path we serve; let another listener handle it, or
    // close if nobody else does.
    if (server.listenerCount("upgrade") <= 1) {
      socket.destroy();
    }
  });

  logger.info(`[websocket] admin binary feed on /ws, public JSON event feed on ${WS_EVENTS_PATH}`);
  return wss;
}

import { scoreEvents, SCORE_UPDATE_EVENT } from "./events";

/** Push a score update to every connection subscribed to that project. */
export function broadcastScoreUpdate(update: ScoreUpdate): void {
  scoreEvents.emit(SCORE_UPDATE_EVENT, update);
  if (!wss) return;
  const frame = encodeScoreUpdate(update);
  for (const [ws, state] of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (state.all || state.subscriptions.has(update.project_id)) {
      try {
        ws.send(frame);
      } catch (error) {
        // Socket was closed between readyState check and send — clean up
        ws.close();
        clients.delete(ws);
      }
    }
  }
}
