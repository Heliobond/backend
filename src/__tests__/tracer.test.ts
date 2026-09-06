import { getTraces, getTraceSummary } from "../lib/tracer";

test("tracer functions work", () => {
  expect(Array.isArray(getTraces({}))).toBe(true);
  // Empty store: no spans recorded yet, so the summary is all zeros.
  const summary = getTraceSummary();
  expect(summary.total_spans).toBe(0);
  expect(summary.traces).toBe(0);
  expect(summary.avg_duration_ms).toBe(0);
});
