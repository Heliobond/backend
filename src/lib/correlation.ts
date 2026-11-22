import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface CorrelationContext {
  correlationId: string;
}

export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export function getCorrelationId(): string {
  return correlationStorage.getStore()?.correlationId ?? "no-context";
}

export function generateCorrelationId(prefix?: string): string {
  return prefix ? `${prefix}-${randomUUID()}` : randomUUID();
}

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationStorage.run({ correlationId }, fn);
}
