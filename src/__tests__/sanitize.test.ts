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

  it("strips HTML tags from string values in the body", () => {
    req.body = { name: '<script>alert("x")</script>Alice' };
    sanitizeInputs(req, res, next);
    expect(req.body.name).toBe('alert("x")Alice');
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
    expect(next).toHaveBeenCalled();
  });
});
