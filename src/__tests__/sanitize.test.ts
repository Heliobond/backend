import { sanitizeInputs } from "../middleware/sanitize";

describe("sanitizeInputs", () => {
  let req: any, res: any, next: jest.Mock;

  beforeEach(() => {
    req = { query: {}, params: {}, body: undefined };
    res = {};
    next = jest.fn();
  });

  it("passes safe string values in query and params through unchanged", () => {
    req.query = { name: "Alice" };
    req.params = { id: "42" };
    sanitizeInputs(req, res, next);
    expect(req.query.name).toBe("Alice");
    expect(req.params.id).toBe("42");
    expect(next).toHaveBeenCalled();
  });

  it("rejects SQL injection patterns in query strings", () => {
    req.query = { q: "'; DROP TABLE users; --" };
    sanitizeInputs(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
  });

  it("passes body strings through unchanged, including angle brackets", () => {
    req.body = { note: "output < 50kW", compare: "50 < 60", tag: "a<b>c" };
    sanitizeInputs(req, res, next);
    expect(req.body.note).toBe("output < 50kW");
    expect(req.body.compare).toBe("50 < 60");
    expect(req.body.tag).toBe("a<b>c");
    expect(next).toHaveBeenCalled();
  });

  it("does not reject ordinary prose with dashes, comments or placeholders", () => {
    req.body = {
      prose: "don't do this -- see docs",
      comment: "a /* note */ here",
      template: "use ${amount} tokens",
    };
    req.query = { q: "don't do this -- see docs" };
    sanitizeInputs(req, res, next);
    expect(req.body.prose).toBe("don't do this -- see docs");
    expect(req.body.comment).toBe("a /* note */ here");
    expect(req.body.template).toBe("use ${amount} tokens");
    expect(req.query.q).toBe("don't do this -- see docs");
    expect(next).toHaveBeenCalled();
  });

  it("still rejects real SQL injection patterns", () => {
    for (const q of ["' OR 1=1", "' or 'x'='x", "1 UNION SELECT * FROM users"]) {
      next.mockClear();
      req.query = { q };
      sanitizeInputs(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    }
  });

  it("still rejects real command injection sequences", () => {
    for (const q of ["`rm -rf /`", "$(whoami)"]) {
      next.mockClear();
      req.query = { q };
      sanitizeInputs(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    }
  });

  it("drops __proto__, constructor and prototype body keys", () => {
    req.body = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": {"polluted": true}, "prototype": {"polluted": true}, "name": "Alice"}',
    );
    sanitizeInputs(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(req.body, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(req.body, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(req.body, "prototype")).toBe(false);
    expect(req.body.name).toBe("Alice");
  });

  it("treats body and query consistently for the same value", () => {
    req.body = { text: "50 < 60" };
    req.query = { text: "50 < 60" };
    sanitizeInputs(req, res, next);
    expect(req.body.text).toBe("50 < 60");
    expect(req.query.text).toBe("50 < 60");
    expect(next).toHaveBeenCalled();
  });

  it("preserves non-string values", () => {
    req.query = { count: 1, active: true };
    sanitizeInputs(req, res, next);
    expect(req.query.count).toBe(1);
    expect(req.query.active).toBe(true);
    expect(next).toHaveBeenCalled();
  });

  it("handles missing query/params", () => {
    delete req.query;
    delete req.params;
    expect(() => sanitizeInputs(req, res, next)).not.toThrow();
    expect(next).toHaveBeenCalledWith();
  });

  it("applies the same string limits to repeated query values and body arrays", () => {
    const values = ["ordinary prose", "a".repeat(10_001)];
    for (const field of ["body", "query"]) {
      next.mockClear();
      sanitizeInputs({ query: {}, params: {}, [field]: { values } } as typeof req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "input_too_long" }));
    }
  });
});
