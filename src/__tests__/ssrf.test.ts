import { validatePublicUrl } from "../lib/ssrf";

describe("SSRF validation", () => {
  describe("Happy path - allowed public URLs", () => {
    it("should allow valid http URL", async () => {
      const result = await validatePublicUrl("http://example.com/api");
      expect(result).toBe("http://example.com/api");
    });

    it("should allow valid https URL", async () => {
      const result = await validatePublicUrl("https://example.com/api");
      expect(result).toBe("https://example.com/api");
    });

    it("should allow URL with query parameters", async () => {
      const result = await validatePublicUrl("https://example.com/api?foo=bar");
      expect(result).toBe("https://example.com/api?foo=bar");
    });

    it("should allow URL with port", async () => {
      const result = await validatePublicUrl("https://example.com:8080/api");
      expect(result).toBe("https://example.com:8080/api");
    });

    it("should allow public IP address", async () => {
      const result = await validatePublicUrl("http://8.8.8.8");
      expect(result).toBe("http://8.8.8.8/");
    });
  });

  describe("Error path - invalid URL format", () => {
    it("should reject malformed URL", async () => {
      await expect(validatePublicUrl("not-a-url")).rejects.toThrow(
        "url must be a valid http/https URL",
      );
    });

    it("should reject URL without protocol", async () => {
      await expect(validatePublicUrl("example.com")).rejects.toThrow(
        "url must be a valid http/https URL",
      );
    });

    it("should reject empty string", async () => {
      await expect(validatePublicUrl("")).rejects.toThrow("url must be a valid http/https URL");
    });
  });

  describe("Error path - blocked protocols", () => {
    it("should reject file:// protocol", async () => {
      await expect(validatePublicUrl("file:///etc/passwd")).rejects.toThrow(
        "url must be a valid http/https URL",
      );
    });

    it("should reject ftp:// protocol", async () => {
      await expect(validatePublicUrl("ftp://example.com")).rejects.toThrow(
        "url must be a valid http/https URL",
      );
    });

    it("should reject gopher:// protocol", async () => {
      await expect(validatePublicUrl("gopher://example.com")).rejects.toThrow(
        "url must be a valid http/https URL",
      );
    });

    it("should reject javascript: protocol", async () => {
      await expect(validatePublicUrl("javascript:alert(1)")).rejects.toThrow(
        "url must be a valid http/https URL",
      );
    });

    it("should reject data: protocol", async () => {
      await expect(validatePublicUrl("data:text/html,<script>alert(1)</script>")).rejects.toThrow(
        "url must be a valid http/https URL",
      );
    });
  });

  describe("Error path - blocked IPv4 ranges", () => {
    it("should reject loopback address 127.0.0.1", async () => {
      await expect(validatePublicUrl("http://127.0.0.1")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject loopback range 127.x.x.x", async () => {
      await expect(validatePublicUrl("http://127.1.2.3")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject private network 10.x.x.x", async () => {
      await expect(validatePublicUrl("http://10.0.0.1")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject private network 192.168.x.x", async () => {
      await expect(validatePublicUrl("http://192.168.1.1")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject private network 172.16-31.x.x", async () => {
      await expect(validatePublicUrl("http://172.16.0.1")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject link-local address 169.254.x.x (AWS metadata)", async () => {
      await expect(validatePublicUrl("http://169.254.169.254")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject CGNAT range 100.64.x.x", async () => {
      await expect(validatePublicUrl("http://100.64.0.1")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject 0.0.0.0/8 range", async () => {
      await expect(validatePublicUrl("http://0.0.0.0")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject multicast address 224.x.x.x", async () => {
      await expect(validatePublicUrl("http://224.0.0.1")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject reserved address 240.x.x.x", async () => {
      await expect(validatePublicUrl("http://240.0.0.1")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject TEST-NET-1 192.0.2.x", async () => {
      await expect(validatePublicUrl("http://192.0.2.1")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject TEST-NET-2 198.51.100.x", async () => {
      await expect(validatePublicUrl("http://198.51.100.1")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject TEST-NET-3 203.0.113.x", async () => {
      await expect(validatePublicUrl("http://203.0.113.1")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });
  });

  describe("Error path - blocked IPv6 ranges", () => {
    it("should reject IPv6 loopback ::1", async () => {
      await expect(validatePublicUrl("http://[::1]")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject IPv6 unspecified ::", async () => {
      await expect(validatePublicUrl("http://[::]")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject IPv6 unique local fc00::/7", async () => {
      await expect(validatePublicUrl("http://[fc00::1]")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject IPv6 unique local fd00::/7", async () => {
      await expect(validatePublicUrl("http://[fd00::1]")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject IPv6 link-local fe80::/10", async () => {
      await expect(validatePublicUrl("http://[fe80::1]")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject IPv6 site-local fec0::/10", async () => {
      await expect(validatePublicUrl("http://[fec0::1]")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject IPv6 multicast ff00::/8", async () => {
      await expect(validatePublicUrl("http://[ff00::1]")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });

    it("should reject IPv6 documentation 2001:db8::/32", async () => {
      await expect(validatePublicUrl("http://[2001:db8::1]")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });
  });

  describe("Edge cases - URL encoding and normalization", () => {
    it("should handle percent-encoded URLs", async () => {
      const result = await validatePublicUrl("https://example.com/api%20endpoint");
      expect(result).toBe("https://example.com/api%20endpoint");
    });

    it("should normalize URL with fragment", async () => {
      const result = await validatePublicUrl("https://example.com/page#section");
      expect(result).toBe("https://example.com/page#section");
    });

    it("should handle URL with username and password", async () => {
      const result = await validatePublicUrl("https://user:pass@example.com");
      expect(result).toBe("https://user:pass@example.com/");
    });
  });

  describe("Edge cases - DNS resolution", () => {
    it("should reject hostname that resolves to private IP", async () => {
      // localhost typically resolves to 127.0.0.1
      await expect(validatePublicUrl("http://localhost")).rejects.toThrow(
        "url must not point to a private, loopback, link-local, or metadata address",
      );
    });
  });
});
