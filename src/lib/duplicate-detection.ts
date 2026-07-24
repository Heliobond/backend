export function tryBeginUpdate(id: any): { allowed: boolean; key: string; reason: string } {
  return {
    allowed: true,
    key: "mock-key",
    reason: "",
  };
}

export function markCompleted(id: any): void {
  return;
}

export function markFailed(id: any): void {
  return;
}
