import {
  generateCorrelationId,
  getCorrelationId,
  runWithCorrelationId,
  correlationStorage,
} from "../lib/correlation";

describe("Correlation ID Module", () => {
  describe("generateCorrelationId", () => {
    it("generates unique correlation IDs", () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();

      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe("string");
      expect(typeof id2).toBe("string");
    });

    it("generates correlation ID with prefix", () => {
      const prefix = "test-req";
      const id = generateCorrelationId(prefix);

      expect(id).toMatch(new RegExp(`^${prefix}-[a-f0-9-]+$`));
    });

    it("generates UUID format without prefix", () => {
      const id = generateCorrelationId();
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  describe("getCorrelationId", () => {
    it("returns 'no-context' when no correlation context is set", () => {
      const id = getCorrelationId();
      expect(id).toBe("no-context");
    });

    it("returns correlation ID from current context", () => {
      const testId = "test-correlation-123";

      runWithCorrelationId(testId, () => {
        const id = getCorrelationId();
        expect(id).toBe(testId);
      });
    });
  });

  describe("runWithCorrelationId", () => {
    it("sets correlation ID in async local storage context", () => {
      const testId = "test-context-456";

      const result = runWithCorrelationId(testId, () => {
        const store = correlationStorage.getStore();
        expect(store).toBeDefined();
        expect(store?.correlationId).toBe(testId);
        return "success";
      });

      expect(result).toBe("success");
    });

    it("propagates correlation ID through nested calls", () => {
      const parentId = "parent-789";

      runWithCorrelationId(parentId, () => {
        expect(getCorrelationId()).toBe(parentId);

        // Nested function call
        function nestedFunction() {
          expect(getCorrelationId()).toBe(parentId);
        }

        nestedFunction();
      });
    });

    it("isolates correlation contexts across different runs", () => {
      const id1 = "context-1";
      const id2 = "context-2";

      runWithCorrelationId(id1, () => {
        expect(getCorrelationId()).toBe(id1);
      });

      runWithCorrelationId(id2, () => {
        expect(getCorrelationId()).toBe(id2);
      });

      // Outside of both contexts
      expect(getCorrelationId()).toBe("no-context");
    });

    it("handles async operations within context", async () => {
      const testId = "async-test-999";

      await runWithCorrelationId(testId, async () => {
        expect(getCorrelationId()).toBe(testId);

        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(getCorrelationId()).toBe(testId);
      });
    });

    it("returns the result of the provided function", () => {
      const expectedResult = { data: "test-data", status: "ok" };

      const result = runWithCorrelationId("test-id", () => {
        return expectedResult;
      });

      expect(result).toEqual(expectedResult);
    });
  });
});
