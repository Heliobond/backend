import { isErrorRateLimited, resetErrorRateLimit, ERROR_RATE_LIMIT_WINDOW_MS } from '../lib/error-limiter';

describe('error-limiter', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('limits, expires, and resets per key', () => {
    expect(isErrorRateLimited('key')).toBe(false);
    expect(isErrorRateLimited('key')).toBe(true);
    jest.advanceTimersByTime(ERROR_RATE_LIMIT_WINDOW_MS + 1);
    expect(isErrorRateLimited('key')).toBe(false);
    resetErrorRateLimit('key');
    expect(isErrorRateLimited('key')).toBe(false);
  });
});
