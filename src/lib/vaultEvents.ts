/**
 * Browser-shaped vault event stream (#767).
 *
 * The frontend's `VaultEventStream` opens `new WebSocket(NEXT_PUBLIC_WS_URL)`
 * against `/ws/events`, sends no subscribe frame, and filters incoming
 * messages by `contractId === NEXT_PUBLIC_VAULT_CONTRACT_ID`. This module
 * defines the shared `VaultEvent` contract those frames must satisfy, plus a
 * `broadcastVaultEvent` helper that other code (typically the on-chain
 * indexer) calls whenever a fresh event should be pushed to connected
 * browsers.
 *
 * The WebSocket transport itself lives in `src/lib/websocket.ts` under the
 * `attachEventsWebSocketServer` export; keeping the wire format here means a
 * shared fixture can be imported from tests without pulling in the `ws`
 * server dependency.
 */

import { EventEmitter } from "events";

/**
 * Vault event pushed to browser subscribers over `/ws/events`.
 *
 * The frontend's `VaultEvent` interface (see `src/lib/websocket.ts:4-11` on
 * the frontend) is the source of truth for this shape. Keep the fields, the
 * types, and the ordering aligned. Any change here must ship together with a
 * frontend update.
 */
export interface VaultEvent {
  /** Event type, e.g. `"ScoreChanged"` for the registry event stream. */
  type: string;
  /** Contract that emitted the event. Used for client-side filtering. */
  contractId: string;
  /** Stellar ledger number the event was recorded on. */
  ledger: number;
  /** Raw Soroban event topics (base64 XDR strings from the RPC). */
  topic: string[];
  /** Decoded event payload. Shape depends on `type`. */
  value: unknown;
  /** Stable, unique identifier for this event (dedup key on the client). */
  id: string;
}

/** Event name used with `vaultEventEmitter`. */
export const VAULT_EVENT = "vault_event";

/**
 * Emitter used to fan out vault events to the WebSocket server without
 * introducing a hard dependency from event producers on the `ws` library.
 * `broadcastVaultEvent` emits into this; `attachEventsWebSocketServer`
 * subscribes on startup.
 */
export const vaultEventEmitter = new EventEmitter();

/**
 * Best-effort validation that a candidate object satisfies the `VaultEvent`
 * shape. Returns false rather than throwing so callers can log and drop the
 * event instead of crashing the emitter.
 */
export function isVaultEvent(candidate: unknown): candidate is VaultEvent {
  if (typeof candidate !== "object" || candidate === null) return false;
  const c = candidate as Record<string, unknown>;
  return (
    typeof c.type === "string" &&
    typeof c.contractId === "string" &&
    typeof c.ledger === "number" &&
    Number.isFinite(c.ledger) &&
    Array.isArray(c.topic) &&
    (c.topic as unknown[]).every((t) => typeof t === "string") &&
    "value" in c &&
    typeof c.id === "string"
  );
}

/**
 * Publish a vault event to every connected `/ws/events` client whose
 * configured contract filter matches (or that omitted the filter). No-ops
 * quietly when the shape is invalid; production code should never rely on
 * a silent drop, but tests and dev-mode simulations sometimes emit
 * partially-formed events.
 */
export function broadcastVaultEvent(evt: VaultEvent): void {
  if (!isVaultEvent(evt)) return;
  vaultEventEmitter.emit(VAULT_EVENT, evt);
}
