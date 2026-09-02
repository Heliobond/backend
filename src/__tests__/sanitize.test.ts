import { sanitizeInputs } from '../middleware/sanitize';

describe('sanitizeInputs', () => {
  let req: any, res: any, next: jest.Mock;

  beforeEach(() => {
    req = { query: {}, params: {} };
    res = {};
    next = jest.fn();
  });

  it('trims string values in query and params', () => {
    req.query = { name: '  Alice   ' };
    req.params = { id: '  42  ' };
    sanitizeInputs(req, res, next);
    expect(req.query.name).toBe('Alice');
    expect(req.params.id).toBe('42');
    expect(next).toHaveCalled();
  });

  it('preserves non-string values', () => {
    req.query = { count: 1, active: true };
    sanitizeInputs(req, res, next);
    expect(req.query.count).toBe(1);
    expect(req.query.active).toBe(true);
    expect(next).toHaveCalled();
  });

  it('handles missing query/params', () => {
    delete req.query;
    delete req.params;
    expect(() => sanitizeInputs(req, res, next)).not.toThrow();
    expect(next).toHaveCalled();
  });
});
