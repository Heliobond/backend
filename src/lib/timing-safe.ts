import { createHash, timingSafeEqual } from "crypto";

/**
 * Constant-time string comparison.
 *
 * A plain `a === b` short-circuits on the first differing byte, so the time it
 * takes to reject a value leaks how many leading characters were correct — enough
 * for an attacker to recover a secret byte-by-byte. Both inputs are hashed to a
 * fixed 32-byte digest first so `timingSafeEqual` always compares equal-length
 * buffers and the comparison never leaks the length of either input either.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}
