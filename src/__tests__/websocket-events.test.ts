import { createServer } from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { attachWebSocketServer, _resetEventsServerForTests } from "../lib/websocket";
import { broadcastVaultEvent, isVaultEvent, type VaultEvent } from "../lib/vaultEvents";
import vaultEventFixture from "./fixtures/vault-event.json";

// Coverage for #767.
//
// The shared fixture at `./fixtures/vault-event.json` is the contract
// between backend and frontend. `isVaultEvent` accepts anything that
// matches the frontend's `VaultEvent` interface, so if either side edits
// the shape without updating the fixture the contract test below fails.

function port(server: import("http").Server): number {
  return (server.address() as AddressInfo).port;
}

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

async function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onMessage = (data: unknown): void => {
      cleanup();
      resolve(typeof data === "string" ? data : String(data));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("socket closed before a message arrived"));
    };
    const cleanup = (): void => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
    ws.on("close", onClose);
  });
}

async function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe("VaultEvent contract test (#767)", () => {
  it("shared fixture satisfies the VaultEvent interface", () => {
    expect(isVaultEvent(vaultEventFixture)).toBe(true);
    // Enumerate every field so the test fails loudly on rename/removal
    // rather than silently accepting a still-typechecking mutation.
    const evt = vaultEventFixture as VaultEvent;
    expect(typeof evt.type).toBe("string");
    expect(typeof evt.contractId).toBe("string");
    expect(typeof evt.ledger).toBe("number");
    expect(Array.isArray(evt.topic)).toBe(true);
    expect(evt.topic.every((t) => typeof t === "string")).toBe(true);
    expect("value" in evt).toBe(true);
    expect(typeof evt.id).toBe("string");
  });

  it("isVaultEvent rejects structurally invalid candidates", () => {
    expect(isVaultEvent(null)).toBe(false);
    expect(isVaultEvent({})).toBe(false);
    expect(
      isVaultEvent({
        type: "ScoreChanged",
        contractId: "C...",
        // ledger missing
        topic: [],
        value: {},
        id: "1",
      }),
    ).toBe(false);
    expect(
      isVaultEvent({
        ...vaultEventFixture,
        topic: [1, 2, 3],
      }),
    ).toBe(false);
  });
});

describe("/ws/events browser stream (#767)", () => {
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    _resetEventsServerForTests();
    server = createServer();
    attachWebSocketServer(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    _resetEventsServerForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("accepts a browser-style connection with no headers and delivers a JSON frame", async () => {
    const url = `ws://127.0.0.1:${port(server)}/ws/events`;
    // Explicitly pass no auth headers; the constructor call mirrors the
    // frontend's `new WebSocket(url)`.
    const ws = await connect(url);
    const received = nextMessage(ws);
    // Give the connection a tick to register before broadcasting.
    await new Promise((r) => setImmediate(r));
    broadcastVaultEvent(vaultEventFixture as VaultEvent);
    const frame = await received;
    const parsed = JSON.parse(frame);
    expect(parsed).toEqual(vaultEventFixture);
    expect(isVaultEvent(parsed)).toBe(true);
    ws.close();
  });

  it("filters by ?contract=<id> so a client only sees its vault's events", async () => {
    const targetContract = (vaultEventFixture as VaultEvent).contractId;
    const url = `ws://127.0.0.1:${port(server)}/ws/events?contract=${targetContract}`;
    const ws = await connect(url);
    const received = nextMessage(ws);
    await new Promise((r) => setImmediate(r));

    // Wrong contract first: must not reach the client.
    broadcastVaultEvent({
      ...(vaultEventFixture as VaultEvent),
      contractId: "CDIFFERENTCONTRACTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      id: "wrong-1",
    });
    // Then the matching one: this is what should arrive.
    broadcastVaultEvent(vaultEventFixture as VaultEvent);
    const frame = await received;
    const parsed = JSON.parse(frame);
    expect(parsed.id).toBe((vaultEventFixture as VaultEvent).id);
    ws.close();
  });

  it("enforces WS_EVENTS_MAX_PER_IP and closes the excess connection with 1013", async () => {
    process.env.WS_EVENTS_MAX_PER_IP = "2";
    // Restart the server with the new env so the limit takes effect.
    _resetEventsServerForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer();
    attachWebSocketServer(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const url = `ws://127.0.0.1:${port(server)}/ws/events`;
    const a = await connect(url);
    const b = await connect(url);
    const c = new WebSocket(url);
    const { code } = await closed(c);
    expect(code).toBe(1013);
    a.close();
    b.close();
    delete process.env.WS_EVENTS_MAX_PER_IP;
  });

  it("the authenticated /ws feed still rejects unauthenticated upgrade requests", async () => {
    // `authenticate` returns true in dev/test when `WS_AUTH_TOKEN` is
    // unset; force production semantics so the reject-on-no-bearer path
    // is exercised.
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const url = `ws://127.0.0.1:${port(server)}/ws`;
      const ws = new WebSocket(url);
      await new Promise<void>((resolve) => {
        ws.once("error", () => resolve());
        ws.once("unexpected-response", () => {
          ws.terminate();
          resolve();
        });
        ws.once("close", () => resolve());
      });
      expect(ws.readyState).not.toBe(WebSocket.OPEN);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
