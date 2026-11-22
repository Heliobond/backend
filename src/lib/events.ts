import { EventEmitter } from "events";

export const scoreEvents = new EventEmitter();

// Event names
export const SCORE_UPDATE_EVENT = "score_update";

export function emitScoreUpdate(update: unknown): void {
  const listeners = scoreEvents.listeners(SCORE_UPDATE_EVENT);

  for (const listener of listeners) {
    try {
      listener.call(scoreEvents, update);
    } catch (error) {
      try {
        if (scoreEvents.listenerCount("error") > 0) {
          scoreEvents.emit("error", error);
        }
      } catch {
        // ignore secondary error-listener failures; the event broadcast must
        // remain best-effort for the cron / websocket pipeline.
      }
    }
  }
}
