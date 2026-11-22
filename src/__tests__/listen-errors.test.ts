import { describeListenError, handleListenError } from "../lib/listen-errors";

function errno(code: string, message = "listen error"): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("listen error handling (#206)", () => {
  describe("describeListenError", () => {
    it("explains EADDRINUSE with the conflicting port", () => {
      expect(describeListenError(errno("EADDRINUSE"), 3001)).toBe(
        "Port 3001 is already in use. Stop the process using it or set PORT to a free port.",
      );
    });

    it("explains EACCES as a privilege problem", () => {
      const message = describeListenError(errno("EACCES"), 80);
      expect(message).toContain("Port 80");
      expect(message).toContain("elevated privileges");
    });

    it("explains EADDRNOTAVAIL", () => {
      expect(describeListenError(errno("EADDRNOTAVAIL"), 3001)).toContain("not available");
    });

    it("falls back to the underlying message for other listen errors", () => {
      const message = describeListenError(errno("EPERM", "operation not permitted"), 3001);
      expect(message).toBe("Failed to bind to port 3001: operation not permitted");
    });

    it("handles errors without a code", () => {
      const err = new Error("boom") as NodeJS.ErrnoException;
      expect(describeListenError(err, 3001)).toBe("Failed to bind to port 3001: boom");
    });
  });

  describe("handleListenError", () => {
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    it("exits with status code 1 on a bind failure", () => {
      const exit = jest.fn();
      handleListenError(errno("EADDRINUSE"), 3001, exit);
      expect(exit).toHaveBeenCalledWith(1);
    });

    it("logs a clear port-conflict message", () => {
      handleListenError(errno("EADDRINUSE"), 3001, jest.fn());
      const logged = errorSpy.mock.calls[0][0] as string;
      expect(logged).toContain("Port 3001 is already in use");
      expect(JSON.parse(logged)).toMatchObject({ level: "error", error_code: "EADDRINUSE" });
    });

    it("exits on non-EADDRINUSE listen errors too", () => {
      const exit = jest.fn();
      handleListenError(errno("EACCES"), 80, exit);
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
