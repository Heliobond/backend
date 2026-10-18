import { EventEmitter } from "events";
import { logger } from "./logger";

export const scoreEvents = new EventEmitter();

// Event names
export const SCORE_UPDATE_EVENT = "score_update";

type ListenerFn = (...args: unknown[]) => unknown;

/**
 * Dispatches SCORE_UPDATE_EVENT to all listeners with per-listener exception
 * isolation so that an error in one subscriber cannot abort subsequent subscribers
 * or propagate into the caller.
 */
export function emitScoreUpdateSafely(update: unknown): void {
  const listeners = [...scoreEvents.rawListeners(SCORE_UPDATE_EVENT)];
  if (listeners.length === 0) {
    return;
  }
  for (const listener of listeners) {
    try {
      const result = (listener as ListenerFn)(update);
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch((asyncErr: unknown) => {
          logger.error(
            "[events] scoreEvents async listener rejected",
            logger.formatError(asyncErr),
          );
        });
      }
    } catch (err) {
      logger.error(
        "[events] scoreEvents listener threw an unhandled error",
        logger.formatError(err),
      );
    }
  }
}
