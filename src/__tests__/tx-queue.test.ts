import {
  enqueue,
  dequeue,
  peek,
  remove,
  getQueueSize,
  getQueueContents,
  incrementRetry,
  hasExceededMaxRetries,
  clearQueue,
  getMaxRetries,
} from "../lib/tx-queue";

beforeEach(() => {
  clearQueue();
});

describe("enqueue", () => {
  it("should add a transaction to the queue", () => {
    enqueue(1, 85, 70);
    expect(getQueueSize()).toBe(1);
  });

  it("should update existing entry for the same project", () => {
    enqueue(1, 85, 70);
    enqueue(1, 90, 80);

    expect(getQueueSize()).toBe(1);
    const contents = getQueueContents();
    expect(contents[0].creditQuality).toBe(90);
    expect(contents[0].greenImpact).toBe(80);
    expect(contents[0].retryCount).toBe(0);
  });

  it("should record error message", () => {
    enqueue(1, 85, 70, "RPC timeout");
    const contents = getQueueContents();
    expect(contents[0].lastError).toBe("RPC timeout");
  });
});

describe("dequeue", () => {
  it("should remove and return the first item", () => {
    enqueue(1, 85, 70);
    enqueue(2, 80, 65);

    const first = dequeue();
    expect(first?.projectId).toBe(1);
    expect(getQueueSize()).toBe(1);
  });

  it("should return undefined when queue is empty", () => {
    expect(dequeue()).toBeUndefined();
  });
});

describe("peek", () => {
  it("should return first item without removing", () => {
    enqueue(1, 85, 70);
    enqueue(2, 80, 65);

    const first = peek();
    expect(first?.projectId).toBe(1);
    expect(getQueueSize()).toBe(2);
  });
});

describe("remove", () => {
  it("should remove a specific project from the queue", () => {
    enqueue(1, 85, 70);
    enqueue(2, 80, 65);
    enqueue(3, 90, 75);

    remove(2);

    expect(getQueueSize()).toBe(2);
    expect(getQueueContents().map((t) => t.projectId)).toEqual([1, 3]);
  });

  it("should do nothing for unknown project", () => {
    enqueue(1, 85, 70);
    remove(999);
    expect(getQueueSize()).toBe(1);
  });
});

describe("incrementRetry", () => {
  it("should increment retry count for a project", () => {
    enqueue(1, 85, 70);
    incrementRetry(1);
    incrementRetry(1);

    const contents = getQueueContents();
    expect(contents[0].retryCount).toBe(2);
  });

  it("should update lastError", () => {
    enqueue(1, 85, 70);
    incrementRetry(1, "timeout");
    expect(getQueueContents()[0].lastError).toBe("timeout");
  });

  it("should do nothing for unknown project", () => {
    incrementRetry(999);
    expect(getQueueSize()).toBe(0);
  });
});

describe("hasExceededMaxRetries", () => {
  it("should return false when retries are below max", () => {
    enqueue(1, 85, 70);
    expect(hasExceededMaxRetries(1)).toBe(false);
  });

  it("should return true when retries exceed max", () => {
    enqueue(1, 85, 70);
    const max = getMaxRetries();
    for (let i = 0; i < max; i++) {
      incrementRetry(1);
    }
    expect(hasExceededMaxRetries(1)).toBe(true);
  });

  it("should return false for unknown project", () => {
    expect(hasExceededMaxRetries(999)).toBe(false);
  });
});

describe("getQueueContents", () => {
  it("should return a copy of the queue", () => {
    enqueue(1, 85, 70);
    enqueue(2, 80, 65);

    const copy = getQueueContents();
    expect(copy).toHaveLength(2);
    expect(copy[0].projectId).toBe(1);
    expect(copy[1].projectId).toBe(2);

    copy.length = 0;
    expect(getQueueSize()).toBe(2);
  });
});

describe("clearQueue", () => {
  it("should clear all items", () => {
    enqueue(1, 85, 70);
    enqueue(2, 80, 65);
    clearQueue();

    expect(getQueueSize()).toBe(0);
  });
});
