import { encodeScoreUpdate } from "../lib/websocket";

/**
 * This test ensures the binary frame layout documented in API.md remains accurate.
 * If encodeScoreUpdate's byte layout changes, this test will fail and require
 * corresponding documentation updates.
 *
 * Documented layout (API.md, WebSocket section):
 *   [0]      message type   uint8   (0x01 = score update)
 *   [1..4]   project_id     uint32  BE
 *   [5]      credit_quality uint8   (0–100)
 *   [6]      green_impact   uint8   (0–100)
 *   [7..14]  timestamp ms   float64 BE
 */
describe("WebSocket binary frame layout", () => {
  it("produces a 15-byte frame with the documented structure", () => {
    const update = {
      project_id: 42,
      credit_quality: 85,
      green_impact: 72,
      timestamp: 1609459200000, // 2021-01-01 00:00:00 UTC
    };

    const frame = encodeScoreUpdate(update);

    // Total length
    expect(frame.length).toBe(15);

    // Byte 0: message type (0x01)
    expect(frame.readUInt8(0)).toBe(0x01);

    // Bytes 1-4: project_id (uint32 BE)
    expect(frame.readUInt32BE(1)).toBe(42);

    // Byte 5: credit_quality (uint8)
    expect(frame.readUInt8(5)).toBe(85);

    // Byte 6: green_impact (uint8)
    expect(frame.readUInt8(6)).toBe(72);

    // Bytes 7-14: timestamp (float64 BE)
    expect(frame.readDoubleBE(7)).toBe(1609459200000);
  });

  it("clamps credit_quality and green_impact to 0-255", () => {
    const update = {
      project_id: 1,
      credit_quality: 300, // out of range
      green_impact: -50, // out of range
      timestamp: Date.now(),
    };

    const frame = encodeScoreUpdate(update);

    expect(frame.readUInt8(5)).toBe(255); // clamped to max
    expect(frame.readUInt8(6)).toBe(0); // clamped to min
  });

  it("handles fractional scores by rounding", () => {
    const update = {
      project_id: 1,
      credit_quality: 74.7,
      green_impact: 68.3,
      timestamp: Date.now(),
    };

    const frame = encodeScoreUpdate(update);

    expect(frame.readUInt8(5)).toBe(75); // rounded
    expect(frame.readUInt8(6)).toBe(68); // rounded
  });

  it("preserves large project IDs", () => {
    const update = {
      project_id: 999999,
      credit_quality: 50,
      green_impact: 50,
      timestamp: Date.now(),
    };

    const frame = encodeScoreUpdate(update);

    expect(frame.readUInt32BE(1)).toBe(999999);
  });

  it("preserves precise timestamps", () => {
    const timestamp = 1735689600123; // millisecond precision
    const update = {
      project_id: 1,
      credit_quality: 50,
      green_impact: 50,
      timestamp,
    };

    const frame = encodeScoreUpdate(update);

    expect(frame.readDoubleBE(7)).toBe(timestamp);
  });
});
