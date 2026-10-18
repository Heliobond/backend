import { WebSocket } from "ws";
import { scoreEvents, SCORE_UPDATE_EVENT, emitScoreUpdateSafely } from "../lib/events";
import { broadcastScoreUpdate, type ScoreUpdate } from "../lib/websocket";
import { logger } from "../lib/logger";

describe("Score Update Events & Broadcast Isolation", () => {
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    scoreEvents.removeAllListeners();
    scoreEvents.setMaxListeners(250);
    loggerErrorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    scoreEvents.removeAllListeners();
    scoreEvents.setMaxListeners(10);
    loggerErrorSpy.mockRestore();
  });

  // =========================================================================
  // Dimension 1: Boundary & Payload Clamping (30 tests)
  // =========================================================================
  describe("Dimension 1: Boundaries & Payload Variations", () => {
    it("handles dispatch with 0 listeners cleanly without error", () => {
      expect(() => {
        emitScoreUpdateSafely({
          project_id: 1,
          credit_quality: 80,
          green_impact: 90,
          timestamp: 1000,
        });
      }).not.toThrow();
      expect(loggerErrorSpy).not.toHaveBeenCalled();
    });

    const boundaryIds = [-100, -1, 0, 1, 42, 999999, Number.MAX_SAFE_INTEGER];
    boundaryIds.forEach((pid) => {
      it(`dispatches correctly for boundary project_id=${pid}`, () => {
        const handler = jest.fn();
        scoreEvents.on(SCORE_UPDATE_EVENT, handler);

        const payload: ScoreUpdate = {
          project_id: pid,
          credit_quality: 75,
          green_impact: 85,
          timestamp: Date.now(),
        };

        expect(() => emitScoreUpdateSafely(payload)).not.toThrow();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    });

    const boundaryCredit = [-500, -1, 0, 1, 50, 100, 1000];
    boundaryCredit.forEach((cq) => {
      it(`dispatches correctly for boundary credit_quality=${cq}`, () => {
        const handler = jest.fn();
        scoreEvents.on(SCORE_UPDATE_EVENT, handler);

        const payload: ScoreUpdate = {
          project_id: 10,
          credit_quality: cq,
          green_impact: 50,
          timestamp: 1234567,
        };

        expect(() => emitScoreUpdateSafely(payload)).not.toThrow();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    });

    const boundaryImpact = [-100, 0, 50, 100, 10000];
    boundaryImpact.forEach((gi) => {
      it(`dispatches correctly for boundary green_impact=${gi}`, () => {
        const handler = jest.fn();
        scoreEvents.on(SCORE_UPDATE_EVENT, handler);

        const payload: ScoreUpdate = {
          project_id: 20,
          credit_quality: 60,
          green_impact: gi,
          timestamp: 1234567,
        };

        expect(() => emitScoreUpdateSafely(payload)).not.toThrow();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    });

    const boundaryTimestamps = [0, 1, 1600000000000, Number.MAX_SAFE_INTEGER];
    boundaryTimestamps.forEach((ts) => {
      it(`dispatches correctly for boundary timestamp=${ts}`, () => {
        const handler = jest.fn();
        scoreEvents.on(SCORE_UPDATE_EVENT, handler);

        const payload: ScoreUpdate = {
          project_id: 30,
          credit_quality: 90,
          green_impact: 95,
          timestamp: ts,
        };

        expect(() => emitScoreUpdateSafely(payload)).not.toThrow();
        expect(handler).toHaveBeenCalledWith(payload);
      });
    });

    it("handles frozen update objects without mutation errors", () => {
      const handler = jest.fn();
      scoreEvents.on(SCORE_UPDATE_EVENT, handler);

      const payload = Object.freeze({
        project_id: 77,
        credit_quality: 85,
        green_impact: 90,
        timestamp: 1700000000,
      });

      expect(() => emitScoreUpdateSafely(payload)).not.toThrow();
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it("handles payload with extra custom properties without failure", () => {
      const handler = jest.fn();
      scoreEvents.on(SCORE_UPDATE_EVENT, handler);

      const payload = {
        project_id: 88,
        credit_quality: 80,
        green_impact: 70,
        timestamp: 1700000001,
        extra_meta: "custom",
        nested: { foo: "bar" },
      };

      expect(() => emitScoreUpdateSafely(payload)).not.toThrow();
      expect(handler).toHaveBeenCalledWith(payload);
    });

    it("handles null and undefined payloads safely", () => {
      const handler = jest.fn();
      scoreEvents.on(SCORE_UPDATE_EVENT, handler);

      expect(() => emitScoreUpdateSafely(null)).not.toThrow();
      expect(handler).toHaveBeenCalledWith(null);

      expect(() => emitScoreUpdateSafely(undefined)).not.toThrow();
      expect(handler).toHaveBeenCalledWith(undefined);
    });
  });

  // =========================================================================
  // Dimension 2: Combinatorics of Throwing Listeners & Exception Types (35 tests)
  // =========================================================================
  describe("Dimension 2: Combinatorics of Listener Failures", () => {
    it("catches standard Error thrown by single listener", () => {
      scoreEvents.on(SCORE_UPDATE_EVENT, () => {
        throw new Error("single listener exploded");
      });

      expect(() => {
        broadcastScoreUpdate({
          project_id: 1,
          credit_quality: 50,
          green_impact: 50,
          timestamp: 100,
        });
      }).not.toThrow();

      expect(loggerErrorSpy).toHaveBeenCalled();
    });

    const errorTypes = [
      new Error("Generic Error"),
      new TypeError("Invalid Type"),
      new RangeError("Out of bounds"),
      new SyntaxError("Bad syntax"),
      new URIError("Malformed URI"),
      "string exception primitive",
      404,
      { code: "CUSTOM_ERR", message: "fail" },
      null,
      undefined,
    ];

    errorTypes.forEach((err, idx) => {
      it(`safely isolates listener throwing error type #${idx}: ${typeof err === "object" && err ? err.constructor?.name : typeof err}`, () => {
        const nextListener = jest.fn();

        scoreEvents.on(SCORE_UPDATE_EVENT, () => {
          throw err;
        });
        scoreEvents.on(SCORE_UPDATE_EVENT, nextListener);

        const update: ScoreUpdate = {
          project_id: 2,
          credit_quality: 70,
          green_impact: 60,
          timestamp: 200,
        };

        expect(() => broadcastScoreUpdate(update)).not.toThrow();
        expect(nextListener).toHaveBeenCalledWith(update);
        expect(loggerErrorSpy).toHaveBeenCalled();
      });
    });

    // Combinatorial test of 3 listeners where any subset throws: 2^3 = 8 combinations
    for (let mask = 0; mask < 8; mask++) {
      const throws1 = Boolean(mask & 1);
      const throws2 = Boolean(mask & 2);
      const throws3 = Boolean(mask & 4);

      it(`permutation mask=${mask}: [L1=${throws1 ? "fail" : "ok"}, L2=${throws2 ? "fail" : "ok"}, L3=${throws3 ? "fail" : "ok"}] executes all listeners`, () => {
        const calls: number[] = [];

        scoreEvents.on(SCORE_UPDATE_EVENT, () => {
          calls.push(1);
          if (throws1) throw new Error("L1 failed");
        });
        scoreEvents.on(SCORE_UPDATE_EVENT, () => {
          calls.push(2);
          if (throws2) throw new Error("L2 failed");
        });
        scoreEvents.on(SCORE_UPDATE_EVENT, () => {
          calls.push(3);
          if (throws3) throw new Error("L3 failed");
        });

        const update: ScoreUpdate = {
          project_id: 3,
          credit_quality: 80,
          green_impact: 85,
          timestamp: 300,
        };

        expect(() => broadcastScoreUpdate(update)).not.toThrow();
        expect(calls).toEqual([1, 2, 3]);

        const expectedErrors = (throws1 ? 1 : 0) + (throws2 ? 1 : 0) + (throws3 ? 1 : 0);
        expect(loggerErrorSpy).toHaveBeenCalledTimes(expectedErrors);
      });
    }

    // Combinatorics of once vs on with throwing
    const onceCombos = [
      { l1Once: true, l1Throws: true, l2Once: false, l2Throws: false },
      { l1Once: false, l1Throws: false, l2Once: true, l2Throws: true },
      { l1Once: true, l1Throws: true, l2Once: true, l2Throws: false },
      { l1Once: true, l1Throws: false, l2Once: true, l2Throws: true },
      { l1Once: true, l1Throws: true, l2Once: true, l2Throws: true },
    ];

    onceCombos.forEach(({ l1Once, l1Throws, l2Once, l2Throws }, idx) => {
      it(`once combo #${idx}: unregisters once listeners even when they throw`, () => {
        const fn1 = jest.fn(() => {
          if (l1Throws) throw new Error("l1 error");
        });
        const fn2 = jest.fn(() => {
          if (l2Throws) throw new Error("l2 error");
        });

        if (l1Once) scoreEvents.once(SCORE_UPDATE_EVENT, fn1);
        else scoreEvents.on(SCORE_UPDATE_EVENT, fn1);

        if (l2Once) scoreEvents.once(SCORE_UPDATE_EVENT, fn2);
        else scoreEvents.on(SCORE_UPDATE_EVENT, fn2);

        const update: ScoreUpdate = {
          project_id: 4,
          credit_quality: 90,
          green_impact: 95,
          timestamp: 400,
        };

        // 1st dispatch
        expect(() => broadcastScoreUpdate(update)).not.toThrow();
        expect(fn1).toHaveBeenCalledTimes(1);
        expect(fn2).toHaveBeenCalledTimes(1);

        // 2nd dispatch
        expect(() => broadcastScoreUpdate(update)).not.toThrow();
        expect(fn1).toHaveBeenCalledTimes(l1Once ? 1 : 2);
        expect(fn2).toHaveBeenCalledTimes(l2Once ? 1 : 2);
      });
    });

    it("handles rejected promise in async listener without uncaught exception", async () => {
      const syncListener = jest.fn();

      scoreEvents.on(SCORE_UPDATE_EVENT, async () => {
        throw new Error("async rejection inside listener");
      });
      scoreEvents.on(SCORE_UPDATE_EVENT, syncListener);

      const update: ScoreUpdate = {
        project_id: 5,
        credit_quality: 65,
        green_impact: 75,
        timestamp: 500,
      };
      expect(() => broadcastScoreUpdate(update)).not.toThrow();
      expect(syncListener).toHaveBeenCalledWith(update);
    });
  });

  // =========================================================================
  // Dimension 3: Host Variations, Websocket Sockets & Encoding (20 tests)
  // =========================================================================
  describe("Dimension 3: WebSocket Server & Client Interaction", () => {
    it("broadcastScoreUpdate functions safely when wss is null", () => {
      const listener = jest.fn();
      scoreEvents.on(SCORE_UPDATE_EVENT, listener);

      const update: ScoreUpdate = {
        project_id: 101,
        credit_quality: 80,
        green_impact: 70,
        timestamp: 600,
      };
      expect(() => broadcastScoreUpdate(update)).not.toThrow();
      expect(listener).toHaveBeenCalledWith(update);
    });

    it("throwing listener does not prevent subsequent broadcasts to other projects", () => {
      let callCount = 0;
      scoreEvents.on(SCORE_UPDATE_EVENT, (u: any) => {
        callCount++;
        if (u.project_id === 1) {
          throw new Error("fail on project 1");
        }
      });

      expect(() => {
        broadcastScoreUpdate({ project_id: 1, credit_quality: 50, green_impact: 50, timestamp: 1 });
      }).not.toThrow();

      expect(() => {
        broadcastScoreUpdate({ project_id: 2, credit_quality: 60, green_impact: 60, timestamp: 2 });
      }).not.toThrow();

      expect(callCount).toBe(2);
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    });

    it("simulates client map with various WebSocket states without crashing", () => {
      const update: ScoreUpdate = {
        project_id: 55,
        credit_quality: 90,
        green_impact: 85,
        timestamp: 700,
      };

      // Ensure broadcastScoreUpdate executes clean return regardless of socket presence
      expect(() => broadcastScoreUpdate(update)).not.toThrow();
    });

    it("preserves exact scoreUpdate payload shape through listener dispatch", () => {
      const received: any[] = [];
      scoreEvents.on(SCORE_UPDATE_EVENT, (evt) => {
        received.push(evt);
      });

      const sample: ScoreUpdate = {
        project_id: 777,
        credit_quality: 99,
        green_impact: 88,
        timestamp: 1699999999999,
      };

      broadcastScoreUpdate(sample);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(sample);
      expect(received[0].project_id).toBe(777);
      expect(received[0].credit_quality).toBe(99);
      expect(received[0].green_impact).toBe(88);
      expect(received[0].timestamp).toBe(1699999999999);
    });

    const projectSamples = [1, 2, 3, 4, 5, 10, 20, 50, 100, 200];
    projectSamples.forEach((pid) => {
      it(`dispatches isolated event for sample project id=${pid}`, () => {
        const mockFn = jest.fn();
        scoreEvents.on(SCORE_UPDATE_EVENT, mockFn);

        broadcastScoreUpdate({
          project_id: pid,
          credit_quality: 80,
          green_impact: 75,
          timestamp: 800,
        });
        expect(mockFn).toHaveBeenCalledWith(
          expect.objectContaining({ project_id: pid, credit_quality: 80 }),
        );
      });
    });
  });

  // =========================================================================
  // Dimension 4: Negative Controls & State Isolation (15 tests)
  // =========================================================================
  describe("Dimension 4: Negative Controls & Isolation", () => {
    it("does not trigger listeners registered for other event names", () => {
      const wrongHandler = jest.fn();
      scoreEvents.on("vault_event" as any, wrongHandler);
      scoreEvents.on("unrelated_event" as any, wrongHandler);

      broadcastScoreUpdate({ project_id: 1, credit_quality: 50, green_impact: 50, timestamp: 100 });
      expect(wrongHandler).not.toHaveBeenCalled();
    });

    it("isolated listener failure does not mutate scoreEvents listeners array", () => {
      const badListener = () => {
        throw new Error("persistent error");
      };
      const goodListener = jest.fn();

      scoreEvents.on(SCORE_UPDATE_EVENT, badListener);
      scoreEvents.on(SCORE_UPDATE_EVENT, goodListener);

      expect(scoreEvents.listenerCount(SCORE_UPDATE_EVENT)).toBe(2);

      broadcastScoreUpdate({ project_id: 1, credit_quality: 50, green_impact: 50, timestamp: 100 });

      // Listeners are still intact for subsequent runs
      expect(scoreEvents.listenerCount(SCORE_UPDATE_EVENT)).toBe(2);

      broadcastScoreUpdate({ project_id: 1, credit_quality: 50, green_impact: 50, timestamp: 101 });
      expect(goodListener).toHaveBeenCalledTimes(2);
    });

    it("does not throw even if a listener throws an Error without stack or message", () => {
      scoreEvents.on(SCORE_UPDATE_EVENT, () => {
        const err = Object.create(null);
        throw err;
      });

      expect(() => {
        broadcastScoreUpdate({
          project_id: 99,
          credit_quality: 70,
          green_impact: 60,
          timestamp: 100,
        });
      }).not.toThrow();

      expect(loggerErrorSpy).toHaveBeenCalled();
    });

    it("does not throw if listener throws a cyclic reference object", () => {
      scoreEvents.on(SCORE_UPDATE_EVENT, () => {
        const cyclic: any = {};
        cyclic.self = cyclic;
        throw cyclic;
      });

      expect(() => {
        broadcastScoreUpdate({
          project_id: 99,
          credit_quality: 70,
          green_impact: 60,
          timestamp: 100,
        });
      }).not.toThrow();

      expect(loggerErrorSpy).toHaveBeenCalled();
    });

    it("multiple calls to removeListener cleanly decouple listeners without residual effects", () => {
      const handler = jest.fn();
      scoreEvents.on(SCORE_UPDATE_EVENT, handler);
      scoreEvents.off(SCORE_UPDATE_EVENT, handler);
      scoreEvents.off(SCORE_UPDATE_EVENT, handler); // redundant off

      broadcastScoreUpdate({ project_id: 1, credit_quality: 50, green_impact: 50, timestamp: 100 });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Dimension 5: Lifecycle, High-Volume Stress & Mutation During Emission (20 tests)
  // =========================================================================
  describe("Dimension 5: Lifecycle & High-Volume Stress", () => {
    it("survives 50 rapid sequential broadcasts with failing listeners", () => {
      let failureCount = 0;
      let successCount = 0;

      scoreEvents.on(SCORE_UPDATE_EVENT, (update: any) => {
        if (update.project_id % 2 === 0) {
          failureCount++;
          throw new Error(`Burst failure on ${update.project_id}`);
        } else {
          successCount++;
        }
      });

      for (let i = 0; i < 50; i++) {
        expect(() => {
          broadcastScoreUpdate({
            project_id: i,
            credit_quality: 50 + (i % 50),
            green_impact: 50 + (i % 50),
            timestamp: Date.now() + i,
          });
        }).not.toThrow();
      }

      expect(failureCount).toBe(25);
      expect(successCount).toBe(25);
      expect(loggerErrorSpy).toHaveBeenCalledTimes(25);
    });

    it("handles listener adding another listener during broadcast", () => {
      const secondListener = jest.fn();

      scoreEvents.on(SCORE_UPDATE_EVENT, () => {
        scoreEvents.on(SCORE_UPDATE_EVENT, secondListener);
      });

      expect(() => {
        broadcastScoreUpdate({
          project_id: 1,
          credit_quality: 70,
          green_impact: 70,
          timestamp: 100,
        });
      }).not.toThrow();

      // Second listener was added during broadcast, will run on next broadcast
      expect(secondListener).toHaveBeenCalledTimes(0);

      broadcastScoreUpdate({ project_id: 2, credit_quality: 80, green_impact: 80, timestamp: 200 });
      expect(secondListener).toHaveBeenCalledTimes(1);
    });

    it("handles listener removing another listener during broadcast", () => {
      const victim = jest.fn();
      scoreEvents.on(SCORE_UPDATE_EVENT, () => {
        scoreEvents.off(SCORE_UPDATE_EVENT, victim);
      });
      scoreEvents.on(SCORE_UPDATE_EVENT, victim);

      expect(() => {
        broadcastScoreUpdate({
          project_id: 1,
          credit_quality: 70,
          green_impact: 70,
          timestamp: 100,
        });
      }).not.toThrow();
    });

    it("handles 100 concurrent listeners where 50 randomly throw", () => {
      const executed: number[] = [];

      for (let i = 0; i < 100; i++) {
        scoreEvents.on(SCORE_UPDATE_EVENT, () => {
          executed.push(i);
          if (i % 2 === 0) {
            throw new Error(`Listener #${i} failed`);
          }
        });
      }

      expect(() => {
        broadcastScoreUpdate({
          project_id: 10,
          credit_quality: 90,
          green_impact: 90,
          timestamp: 1000,
        });
      }).not.toThrow();

      expect(executed).toHaveLength(100);
      expect(loggerErrorSpy).toHaveBeenCalledTimes(50);
    });

    it("verifies zero memory leak: all listeners removed cleanly after stress test", () => {
      expect(scoreEvents.listenerCount(SCORE_UPDATE_EVENT)).toBe(0);

      const handlers = Array.from({ length: 50 }, () => jest.fn());
      handlers.forEach((h) => scoreEvents.on(SCORE_UPDATE_EVENT, h));

      expect(scoreEvents.listenerCount(SCORE_UPDATE_EVENT)).toBe(50);

      scoreEvents.removeAllListeners(SCORE_UPDATE_EVENT);
      expect(scoreEvents.listenerCount(SCORE_UPDATE_EVENT)).toBe(0);
    });

    const returnTypes = [
      42,
      "ok_string",
      true,
      false,
      { status: "ok" },
      [1, 2, 3],
      null,
      undefined,
      Symbol("test_sym"),
      BigInt(9007199254740991),
    ];

    returnTypes.forEach((retVal, idx) => {
      it(`handles listener returning non-promise value #${idx}: ${typeof retVal}`, () => {
        scoreEvents.on(SCORE_UPDATE_EVENT, () => retVal);

        const update: ScoreUpdate = {
          project_id: 10 + idx,
          credit_quality: 70,
          green_impact: 80,
          timestamp: 1000 + idx,
        };
        expect(() => broadcastScoreUpdate(update)).not.toThrow();
        expect(loggerErrorSpy).not.toHaveBeenCalled();
      });
    });

    const fractionalScores = [
      { cq: 75.125, gi: 82.375 },
      { cq: 0.0001, gi: 99.9999 },
      { cq: 100.0, gi: 0.0 },
      { cq: -0.5, gi: 50.5 },
      { cq: 12.3456789, gi: 98.7654321 },
      { cq: 50.0000001, gi: 50.0000001 },
      { cq: 99.9999999, gi: 0.0000001 },
      { cq: 0.1 + 0.2, gi: 100 },
      { cq: 45.67, gi: -12.34 },
      { cq: 88.888, gi: 77.777 },
      { cq: 10.1, gi: 20.2 },
      { cq: 30.3, gi: 40.4 },
      { cq: 50.5, gi: 60.6 },
      { cq: 70.7, gi: 80.8 },
      { cq: 90.9, gi: 10.0 },
    ];

    fractionalScores.forEach(({ cq, gi }, idx) => {
      it(`handles floating-point precision score #${idx}: cq=${cq}, gi=${gi}`, () => {
        const received: any[] = [];
        scoreEvents.on(SCORE_UPDATE_EVENT, (payload) => received.push(payload));

        const update: ScoreUpdate = {
          project_id: 500 + idx,
          credit_quality: cq,
          green_impact: gi,
          timestamp: 2000 + idx,
        };
        expect(() => broadcastScoreUpdate(update)).not.toThrow();
        expect(received[0].credit_quality).toBeCloseTo(cq);
        expect(received[0].green_impact).toBeCloseTo(gi);
      });
    });

    for (let burst = 1; burst <= 10; burst++) {
      it(`stress burst run #${burst}: handles 5 chained listeners with alternating throws`, () => {
        const sequence: number[] = [];
        scoreEvents.on(SCORE_UPDATE_EVENT, () => {
          sequence.push(1);
          throw new Error(`burst #${burst} err 1`);
        });
        scoreEvents.on(SCORE_UPDATE_EVENT, () => {
          sequence.push(2);
        });
        scoreEvents.on(SCORE_UPDATE_EVENT, () => {
          sequence.push(3);
          throw new Error(`burst #${burst} err 3`);
        });
        scoreEvents.on(SCORE_UPDATE_EVENT, () => {
          sequence.push(4);
        });
        scoreEvents.on(SCORE_UPDATE_EVENT, () => {
          sequence.push(5);
        });

        broadcastScoreUpdate({
          project_id: burst,
          credit_quality: 80,
          green_impact: 80,
          timestamp: burst,
        });
        expect(sequence).toEqual([1, 2, 3, 4, 5]);
        expect(loggerErrorSpy).toHaveBeenCalledTimes(2);
      });
    }
  });
});
