import { scoreEvents, SCORE_UPDATE_EVENT } from "../lib/events";

describe("Events Module", () => {
  beforeEach(() => {
    // Remove all listeners before each test to ensure clean state
    scoreEvents.removeAllListeners();
  });

  afterEach(() => {
    // Clean up listeners after each test
    scoreEvents.removeAllListeners();
  });

  describe("scoreEvents EventEmitter", () => {
    it("emits and receives events", () => {
      const mockHandler = jest.fn();
      const testData = { projectId: 123, score: 95 };

      scoreEvents.on(SCORE_UPDATE_EVENT, mockHandler);
      scoreEvents.emit(SCORE_UPDATE_EVENT, testData);

      expect(mockHandler).toHaveBeenCalledTimes(1);
      expect(mockHandler).toHaveBeenCalledWith(testData);
    });

    it("handles multiple listeners for the same event", () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      const testData = { projectId: 456, score: 88 };

      scoreEvents.on(SCORE_UPDATE_EVENT, handler1);
      scoreEvents.on(SCORE_UPDATE_EVENT, handler2);
      scoreEvents.emit(SCORE_UPDATE_EVENT, testData);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler1).toHaveBeenCalledWith(testData);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledWith(testData);
    });

    it("does not call removed listeners", () => {
      const mockHandler = jest.fn();
      const testData = { projectId: 789, score: 92 };

      scoreEvents.on(SCORE_UPDATE_EVENT, mockHandler);
      scoreEvents.off(SCORE_UPDATE_EVENT, mockHandler);
      scoreEvents.emit(SCORE_UPDATE_EVENT, testData);

      expect(mockHandler).not.toHaveBeenCalled();
    });
  });

  describe("error handling in event callbacks", () => {
    it("throws error when listener throws and no error handler is registered", () => {
      const errorHandler = jest.fn(() => {
        throw new Error("Handler error");
      });

      scoreEvents.on(SCORE_UPDATE_EVENT, errorHandler);

      expect(() => {
        scoreEvents.emit(SCORE_UPDATE_EVENT, { projectId: 111, score: 75 });
      }).toThrow("Handler error");

      expect(errorHandler).toHaveBeenCalled();
    });

    it("allows multiple successful listeners to execute", () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      const testData = { projectId: 222, score: 80 };

      scoreEvents.on(SCORE_UPDATE_EVENT, handler1);
      scoreEvents.on(SCORE_UPDATE_EVENT, handler2);

      scoreEvents.emit(SCORE_UPDATE_EVENT, testData);

      expect(handler1).toHaveBeenCalledWith(testData);
      expect(handler2).toHaveBeenCalledWith(testData);
    });
  });

  describe("SCORE_UPDATE_EVENT constant", () => {
    it("has the correct event name", () => {
      expect(SCORE_UPDATE_EVENT).toBe("score_update");
    });
  });
});
