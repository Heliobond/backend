import { withProjectLock } from "../lib/request-queue";

describe("withProjectLock", () => {
  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("should execute handler for first request", async () => {
    const result = await withProjectLock(1, async () => "test");
    expect(result).toBe("test");
  });

  it("should return same result for concurrent requests", async () => {
    let callCount = 0;
    const gate = deferred<string>();
    const handler = async () => {
      callCount++;
      await gate.promise;
      return "result";
    };

    const pending = Promise.all([
      withProjectLock(1, handler),
      withProjectLock(1, handler),
      withProjectLock(1, handler),
    ]);

    await Promise.resolve();
    expect(callCount).toBe(1);

    gate.resolve("result");

    const [r1, r2, r3] = await pending;
    expect(r1).toBe("result");
    expect(r2).toBe("result");
    expect(r3).toBe("result");
    expect(callCount).toBe(1);
  });

  it("should handle errors for concurrent requests", async () => {
    let callCount = 0;
    const gate = deferred<void>();
    const handler = async () => {
      callCount++;
      await gate.promise;
      throw new Error("test error");
    };

    const pending = Promise.allSettled([
      withProjectLock(1, handler),
      withProjectLock(1, handler),
      withProjectLock(1, handler),
    ]);

    await Promise.resolve();
    expect(callCount).toBe(1);

    gate.resolve();

    const results = await pending;
    expect(callCount).toBe(1);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });

  it("should allow different projects concurrently", async () => {
    let callCount = 0;
    const handler = async () => {
      callCount++;
      await Promise.resolve();
      return "result";
    };

    const [r1, r2] = await Promise.all([withProjectLock(1, handler), withProjectLock(2, handler)]);

    expect(r1).toBe("result");
    expect(r2).toBe("result");
    expect(callCount).toBe(2);
  });

  it("should allow new requests after completion", async () => {
    const r1 = await withProjectLock(1, async () => "first");
    const r2 = await withProjectLock(1, async () => "second");

    expect(r1).toBe("first");
    expect(r2).toBe("second");
  });
});
