import { timingSafeEqual } from "crypto";

/**
 * Size in bytes of the fixed comparison window. Credentials compared through
 * this helper (bearer tokens, API keys, CSRF tokens) are all far smaller than
 * this, so both operands are normally padded to exactly this size and the work
 * `timingSafeEqual` performs is a compile-time constant: neither the contents
 * nor the length of either input is observable. A value larger than the window
 * falls back to the longer of the two lengths, which stays constant-time but
 * does reveal the order of magnitude of the longer input.
 */
const COMPARE_WINDOW_BYTES = 512;

/** Left-aligned copy of `value` in a zero-filled buffer of exactly `size` bytes. */
function padTo(value: Buffer, size: number): Buffer {
  const padded = Buffer.alloc(size);
  value.copy(padded, 0, 0, Math.min(value.length, size));
  return padded;
}

/**
 * Constant-time string comparison.
 *
 * A plain `a === b` short-circuits on the first differing byte, so the time it
 * takes to reject a value leaks how many leading characters were correct — enough
 * for an attacker to recover a secret byte-by-byte. Both inputs are copied into
 * equal-length buffers first so `timingSafeEqual` always compares equal-length
 * buffers, never short-circuits, and no secret-dependent branch is taken.
 *
 * The padding here replaces an earlier implementation that ran both inputs
 * through `createHash("sha256")` purely to give them a common length. The digest
 * was only ever a length normaliser, never a stored password hash, but hashing
 * an API key with a fast general-purpose digest is indistinguishable from an
 * insecure password hash to automated analysis (CodeQL
 * js/insufficient-password-hash), so the normalisation is done without hashing.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  const window = Math.max(bufA.length, bufB.length, COMPARE_WINDOW_BYTES);

  // Executed unconditionally, ahead of the length check, so the secret-dependent
  // work always happens.
  const equalBytes = timingSafeEqual(padTo(bufA, window), padTo(bufB, window));
  // Zero padding would otherwise let "abc" collide with "abc\u0000"; folding the
  // lengths in rules that out.
  const sameLength = bufA.length === bufB.length;

  return equalBytes && sameLength;
}
