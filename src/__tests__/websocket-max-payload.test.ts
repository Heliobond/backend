import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import {
  attachWebSocketServer,
  attachEventsWebSocketServer,
  _resetEventsServerForTests,
  _handleMessageForTests,
  _setClientStateForTests,
  getPayloadByteLength,
  WS_MAX_PAYLOAD_BYTES,
} from "../lib/websocket";

function port(server: HttpServer): number {
  return (server.address() as AddressInfo).port;
}

async function connect(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

async function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
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

describe("WebSocket Max Payload & Resource Exhaustion Protection (#929)", () => {
  let server: HttpServer;

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

  // =========================================================================
  // Dimension 1: Boundary & Clamping
  // =========================================================================
  describe("Dimension 1: Boundary & Clamping", () => {
    it("exports default WS_MAX_PAYLOAD_BYTES as 64 KiB (65536 bytes)", () => {
      expect(WS_MAX_PAYLOAD_BYTES).toBe(64 * 1024);
      expect(WS_MAX_PAYLOAD_BYTES).toBe(65536);
    });

    describe("getPayloadByteLength helper precision across boundary sizes", () => {
      const boundarySizes = [
        0, 1, 2, 15, 64, 128, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65535, 65536, 65537, 70000,
        100000, 131072,
      ];

      for (const size of boundarySizes) {
        it(`calculates exact byte length for string of length ${size}`, () => {
          const str = "x".repeat(size);
          expect(getPayloadByteLength(str)).toBe(size);
        });

        it(`calculates exact byte length for Buffer of size ${size}`, () => {
          const buf = Buffer.alloc(size, 0x61);
          expect(getPayloadByteLength(buf)).toBe(size);
        });

        it(`calculates exact byte length for ArrayBuffer of size ${size}`, () => {
          const ab = new ArrayBuffer(size);
          expect(getPayloadByteLength(ab)).toBe(size);
        });

        it(`calculates exact byte length for Uint8Array view of size ${size}`, () => {
          const u8 = new Uint8Array(size);
          expect(getPayloadByteLength(u8)).toBe(size);
        });
      }

      it("handles multi-byte UTF-8 characters accurately", () => {
        // Cyrillic letters are 2 bytes each in UTF-8
        const cyrillic = "ПриветМир"; // 9 chars * 2 bytes = 18 bytes
        expect(getPayloadByteLength(cyrillic)).toBe(18);

        // 4-byte emojis
        const emoji = "🚀🌍⚡🛡️";
        expect(getPayloadByteLength(emoji)).toBe(Buffer.byteLength(emoji));
      });

      it("gracefully returns 0 for non-buffer/non-string edge cases", () => {
        expect(getPayloadByteLength(null)).toBe(0);
        expect(getPayloadByteLength(undefined)).toBe(0);
        expect(getPayloadByteLength(12345)).toBe(0);
        expect(getPayloadByteLength(true)).toBe(0);
        expect(getPayloadByteLength({})).toBe(0);
      });

      it("aggregates Buffer chunk arrays accurately", () => {
        const chunks = [Buffer.alloc(100), Buffer.alloc(200), Buffer.alloc(300)];
        expect(getPayloadByteLength(chunks)).toBe(600);
      });
    });

    describe("handleMessage boundary enforcement", () => {
      const boundaryDeltas = [-10, -5, -1, 0, 1, 5, 10, 1000, 10000];

      for (const delta of boundaryDeltas) {
        const testSize = WS_MAX_PAYLOAD_BYTES + delta;
        const shouldPass = delta <= 0;

        it(`payload of size ${testSize} bytes (limit ${delta >= 0 ? "+" : ""}${delta}) ${shouldPass ? "is accepted" : "is rejected with 1009"}`, () => {
          let closedCode: number | null = null;
          let closedReason: string | null = null;
          const sent: string[] = [];

          const mockWs = {
            close: (code: number, reason: string) => {
              closedCode = code;
              closedReason = reason;
            },
            send: (msg: string) => {
              sent.push(msg);
            },
          } as unknown as WebSocket;

          _setClientStateForTests(mockWs, { subscriptions: new Set(), all: false });

          // Valid minimal JSON padded to testSize
          const prefix = '{"action":"subscribe","padding":"';
          const suffix = '"}';
          const paddingLen = Math.max(0, testSize - prefix.length - suffix.length);
          const payload = prefix + "a".repeat(paddingLen) + suffix;

          _handleMessageForTests(mockWs, payload);

          if (shouldPass) {
            expect(closedCode).toBeNull();
            expect(sent.length).toBe(1);
            expect(JSON.parse(sent[0]).type).toBe("subscribed");
          } else {
            expect(closedCode).toBe(1009);
            expect(closedReason).toBe("payload too large");
            expect(sent.length).toBe(0);
          }
        });
      }
    });
  });

  // =========================================================================
  // Dimension 2: Combinatorics
  // =========================================================================
  describe("Dimension 2: Combinatorics", () => {
    const payloadTypes = ["string", "Buffer", "ArrayBuffer", "Buffer[]"] as const;
    const actions = ["subscribe", "unsubscribe", "unknown", "invalid-json"] as const;

    for (const pType of payloadTypes) {
      for (const action of actions) {
        it(`combinatorial test: payload type [${pType}] with action [${action}] bounds check`, () => {
          let closedCode: number | null = null;
          const sent: string[] = [];

          const mockWs = {
            close: (code: number) => {
              closedCode = code;
            },
            send: (msg: string) => {
              sent.push(msg);
            },
          } as unknown as WebSocket;

          _setClientStateForTests(mockWs, { subscriptions: new Set(), all: false });

          let rawStr: string;
          if (action === "subscribe")
            rawStr = JSON.stringify({ action: "subscribe", project_ids: [1, 2] });
          else if (action === "unsubscribe")
            rawStr = JSON.stringify({ action: "unsubscribe", all: true });
          else if (action === "unknown") rawStr = JSON.stringify({ action: "ping" });
          else rawStr = "not a valid json frame{{{";

          let data: unknown;
          if (pType === "string") data = rawStr;
          else if (pType === "Buffer") data = Buffer.from(rawStr);
          else if (pType === "ArrayBuffer") {
            const buf = Buffer.from(rawStr);
            data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          } else {
            const buf = Buffer.from(rawStr);
            data = [buf.subarray(0, 5), buf.subarray(5)];
          }

          _handleMessageForTests(mockWs, data);

          // Since all these are well under 64 KiB:
          expect(closedCode).toBeNull();
          if (action === "subscribe" || action === "unsubscribe") {
            expect(sent.length).toBe(1);
            expect(JSON.parse(sent[0]).type).toBe("subscribed");
          } else if (action === "unknown") {
            expect(sent.length).toBe(1);
            expect(JSON.parse(sent[0]).type).toBe("error");
          } else {
            expect(sent.length).toBe(1);
            expect(JSON.parse(sent[0]).message).toBe("invalid JSON control frame");
          }
        });
      }
    }

    it("verifies combinations of oversized payloads across all action types get rejected immediately", () => {
      const actionsToTest = [
        { action: "subscribe", project_ids: [1, 2, 3] },
        { action: "unsubscribe", all: true },
        { action: "custom", flag: true },
      ];

      for (const act of actionsToTest) {
        let closedCode: number | null = null;
        const mockWs = {
          close: (code: number) => {
            closedCode = code;
          },
          send: () => {},
        } as unknown as WebSocket;

        _setClientStateForTests(mockWs, { subscriptions: new Set(), all: false });

        // Build oversized frame (> 64 KiB)
        const frame = JSON.stringify({ ...act, blob: "x".repeat(70000) });
        _handleMessageForTests(mockWs, frame);
        expect(closedCode).toBe(1009);
      }
    });
  });

  // =========================================================================
  // Dimension 3: Host Variations & Connection Types
  // =========================================================================
  describe("Dimension 3: Host Variations & Connection Types", () => {
    it("live network connection to /ws closes client with 1009 on oversized frame", async () => {
      const url = `ws://127.0.0.1:${port(server)}/ws`;
      const ws = await connect(url);

      const closePromise = closed(ws);

      // Send 70 KiB frame (> 64 KiB maxPayload)
      const oversizedPayload = "a".repeat(70 * 1024);
      ws.send(oversizedPayload);

      const { code } = await closePromise;
      expect(code).toBe(1009);
    });

    it("live network connection to /ws/events closes client with 1009 on oversized frame", async () => {
      const url = `ws://127.0.0.1:${port(server)}/ws/events`;
      const ws = await connect(url);

      const closePromise = closed(ws);

      // Send 80 KiB frame (> 64 KiB maxPayload)
      const oversizedPayload = "e".repeat(80 * 1024);
      ws.send(oversizedPayload);

      const { code } = await closePromise;
      expect(code).toBe(1009);
    });

    it("attachEventsWebSocketServer creates WebSocketServer with configured maxPayload", () => {
      _resetEventsServerForTests();
      const standaloneServer = createServer();
      const eventsWss = attachEventsWebSocketServer(standaloneServer);
      expect(eventsWss.options.maxPayload).toBe(WS_MAX_PAYLOAD_BYTES);
      expect(eventsWss.options.noServer).toBe(true);
    });
  });

  // =========================================================================
  // Dimension 4: Negative Controls & Isolation
  // =========================================================================
  describe("Dimension 4: Negative Controls & Isolation", () => {
    it("rejection of an oversized frame on one socket does NOT disconnect other clients", async () => {
      const url = `ws://127.0.0.1:${port(server)}/ws`;
      const clientGood = await connect(url);
      const clientBad = await connect(url);

      const badClosePromise = closed(clientBad);

      // Bad client sends oversized frame
      clientBad.send("x".repeat(70 * 1024));

      const { code } = await badClosePromise;
      expect(code).toBe(1009);

      // Good client sends valid subscribe frame and verifies normal response
      const goodResponsePromise = nextMessage(clientGood);
      clientGood.send(JSON.stringify({ action: "subscribe", project_ids: [42] }));

      const response = await goodResponsePromise;
      const parsed = JSON.parse(response);
      expect(parsed.type).toBe("subscribed");
      expect(parsed.project_ids).toEqual([42]);

      clientGood.close();
    });

    it("normal-sized frames with valid subscribe do not trigger any close code", async () => {
      const url = `ws://127.0.0.1:${port(server)}/ws`;
      const ws = await connect(url);

      const msgPromise = nextMessage(ws);
      ws.send(JSON.stringify({ action: "subscribe", all: true }));
      const msg = await msgPromise;
      expect(JSON.parse(msg).all).toBe(true);
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    });

    it("normal-sized invalid JSON frame returns error JSON and does NOT close socket", async () => {
      const url = `ws://127.0.0.1:${port(server)}/ws`;
      const ws = await connect(url);

      const msgPromise = nextMessage(ws);
      ws.send("this is not json");
      const msg = await msgPromise;
      expect(JSON.parse(msg).message).toBe("invalid JSON control frame");
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    });
  });

  // =========================================================================
  // Dimension 5: Lifecycle & Stress
  // =========================================================================
  describe("Dimension 5: Lifecycle & Stress", () => {
    it("sequential connection stress: 25 rapid oversized attempts terminate cleanly without leak", async () => {
      const url = `ws://127.0.0.1:${port(server)}/ws`;

      for (let i = 0; i < 25; i++) {
        const ws = await connect(url);
        const closePromise = closed(ws);
        ws.send("m".repeat(66 * 1024));
        const { code } = await closePromise;
        expect(code).toBe(1009);
      }
    });

    it("_resetEventsServerForTests cleanly unmounts and closes all sockets and servers", async () => {
      const url = `ws://127.0.0.1:${port(server)}/ws`;
      const ws1 = await connect(url);
      const ws2 = await connect(url);

      const closePromise1 = closed(ws1);
      const closePromise2 = closed(ws2);

      _resetEventsServerForTests();

      await Promise.all([closePromise1, closePromise2]);
      expect(ws1.readyState).not.toBe(WebSocket.OPEN);
      expect(ws2.readyState).not.toBe(WebSocket.OPEN);
    });
  });
});
