import request from 'supertest';
import express from 'express';
import { router } from '../routes/scoring-formulas';

const app = express();
app.use('/v1/scoring/formulas', router);

describe('GET /v1/scoring/formulas', () => {
  it('returns 200 with formulas', async () => {
    const res = await request(app).get('/v1/scoring/formulas');
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });

  it('returns 400 for invalid query', async () => {
    const res = await request(app).get('/v1/scoring/formulas?invalid=true');
    expect(res.status).toBe(400);
  });
});
