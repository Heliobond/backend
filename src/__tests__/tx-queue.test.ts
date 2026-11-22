import {
  enqueue,
  dequeue,
  remove,
  incrementRetry,
  hasExceededMaxRetries,
  getQueueSize,
  getQueueSnapshot,
} from "../lib/tx-queue";

// tx-queue holds module-level singleton state (a `Map`), so drain it before
// every test to keep tests independent of run order and of each other.
function drainQueue(): void {
  while (getQueueSize() > 0) {
    dequeue();
  }
}

describe("tx-queue", () => {
  beforeEach(() => {
    drainQueue();
  });

  describe("enqueue / dequeue / remove", () => {
    it("dequeues items in FIFO order and removes them from the queue", () => {
      enqueue(1, 10, 20, "low satellite confidence");
      enqueue(2, 30, 40, "RPC unavailable");

      expect(getQueueSize()).toBe(2);

      const first = dequeue();
      expect(first?.projectId).toBe(1);
      expect(getQueueSize()).toBe(1);

      const second = dequeue();
      expect(second?.projectId).toBe(2);
      expect(getQueueSize()).toBe(0);
    });

    it("returns undefined when dequeuing an empty queue", () => {
      expect(dequeue()).toBeUndefined();
    });

    it("upserts on re-enqueue: refreshes scores/reason but preserves retryCount", () => {
      enqueue(1, 10, 20, "RPC unavailable");
      incrementRetry(1, "timeout");
      incrementRetry(1, "timeout");

      enqueue(1, 99, 88, "RPC unavailable again");

      const [item] = getQueueSnapshot();
      expect(item.creditQuality).toBe(99);
      expect(item.greenImpact).toBe(88);
      expect(item.reason).toBe("RPC unavailable again");
      expect(item.retryCount).toBe(2);
    });

    it("remove() deletes only the targeted item", () => {
      enqueue(1, 10, 20, "reason");
      enqueue(2, 10, 20, "reason");

      remove(1);

      expect(getQueueSize()).toBe(1);
      expect(getQueueSnapshot()[0].projectId).toBe(2);
    });
  });

  describe("incrementRetry / hasExceededMaxRetries", () => {
    it("is a no-op for a projectId that isn't queued", () => {
      enqueue(1, 10, 20, "reason");
      incrementRetry(999, "not queued");

      expect(getQueueSnapshot()[0].retryCount).toBe(0);
    });

    it("returns false for a projectId that isn't queued", () => {
      expect(hasExceededMaxRetries(999)).toBe(false);
    });

    it("returns false while retryCount is below MAX_RETRIES (default 10)", () => {
      enqueue(1, 10, 20, "reason");
      for (let i = 0; i < 9; i++) incrementRetry(1, "still failing");

      expect(getQueueSnapshot()[0].retryCount).toBe(9);
      expect(hasExceededMaxRetries(1)).toBe(false);
    });

    it("returns true once retryCount reaches MAX_RETRIES (default 10)", () => {
      enqueue(1, 10, 20, "reason");
      for (let i = 0; i < 10; i++) incrementRetry(1, "still failing");

      expect(getQueueSnapshot()[0].retryCount).toBe(10);
      expect(hasExceededMaxRetries(1)).toBe(true);
    });

    it("records the last error message", () => {
      enqueue(1, 10, 20, "reason");
      incrementRetry(1, "RPC timeout");
      incrementRetry(1, "RPC timeout again");

      expect(getQueueSnapshot()[0].lastError).toBe("RPC timeout again");
    });
  });

  describe("getQueueSnapshot", () => {
    it("returns queued items without removing them", () => {
      enqueue(1, 10, 20, "reason");
      enqueue(2, 10, 20, "reason");

      const snapshot = getQueueSnapshot();

      expect(snapshot.map((i) => i.projectId)).toEqual([1, 2]);
      expect(getQueueSize()).toBe(2);
    });
  });

  describe("regression: retry-and-drop after one failed attempt (#532)", () => {
    it("BUG (pinned): dequeue()-then-catch silently drops a retry — incrementRetry and hasExceededMaxRetries become no-ops once the item is dequeued", () => {
      enqueue(1, 10, 20, "RPC unavailable");

      const item = dequeue(); // <-- removes it immediately, as the old cron did
      expect(item?.projectId).toBe(1);
      expect(getQueueSize()).toBe(0);

      incrementRetry(item!.projectId, "RPC timeout");
      expect(hasExceededMaxRetries(item!.projectId)).toBe(false);

      expect(getQueueSize()).toBe(0);
      expect(getQueueSnapshot()).toEqual([]);
    });

    it("FIX: reading via getQueueSnapshot() (no removal) lets a failed attempt stay queued and its retry count accumulate", () => {
      enqueue(1, 10, 20, "RPC unavailable");

      const [item] = getQueueSnapshot(); // <-- does NOT remove it
      expect(item.projectId).toBe(1);
      expect(getQueueSize()).toBe(1);

      incrementRetry(item.projectId, "RPC timeout");

      expect(getQueueSize()).toBe(1);
      expect(hasExceededMaxRetries(item.projectId)).toBe(false);
      expect(getQueueSnapshot()[0].retryCount).toBe(1);
      expect(getQueueSnapshot()[0].lastError).toBe("RPC timeout");
    });

    it("FIX: an item that keeps failing is only removed once it exceeds MAX_RETRIES, not after one attempt", () => {
      enqueue(1, 10, 20, "RPC unavailable");

      for (let attempt = 1; attempt <= 10; attempt++) {
        const [item] = getQueueSnapshot();
        expect(item).toBeDefined();

        incrementRetry(item.projectId, `attempt ${attempt} failed`);

        if (hasExceededMaxRetries(item.projectId)) {
          remove(item.projectId);
        }
      }

      expect(getQueueSize()).toBe(0);
    });
  });
});
