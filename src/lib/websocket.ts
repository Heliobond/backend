import type { Server as HttpServer, IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";

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
 * Authenticate an incoming upgrade request. The token may be supplied as a
 * `?token=` query parameter or an `Authorization: Bearer <token>` header. When
 * neither WS_AUTH_TOKEN nor ADMIN_API_KEY is set, auth is skipped (dev only).
 */
function authenticate(req: IncomingMessage): boolean {
  const expected = process.env.WS_AUTH_TOKEN || process.env.ADMIN_API_KEY;
  if (!expected) return true;
  const url = new URL(req.url ?? "/", "http://localhost");
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const token = url.searchParams.get("token") ?? bearer;
  return token === expected;
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

/**
 * Attach a WebSocket server to an existing HTTP server. Clients connect at
 * `/ws`, authenticate on upgrade, then send JSON control frames to manage
 * their subscriptions and receive binary score-update frames.
 */
export function attachWebSocketServer(server: HttpServer): WebSocketServer {
  wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info, cb) => {
      if (authenticate(info.req)) return cb(true);
      cb(false, 1008, "Unauthorized");
    },
  });

  wss.on("connection", (ws) => {
    clients.set(ws, { subscriptions: new Set(), all: false });
    ws.on("message", (data) => handleMessage(ws, data));
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

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
      ws.send(frame);
    }
  }
}
