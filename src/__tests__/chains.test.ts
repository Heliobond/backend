import { Request, Response } from 'express';
import { listChains, configureChain, broadcastTransaction } from '../routes/chains';

jest.mock('../lib/chains', () => ({
  getChains: jest.fn(),
  addChain: jest.fn(),
  broadcast: jest.fn(),
}));

import { getChains, addChain, broadcast } from '../lib/chains';

describe('chains route handlers', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  beforeEach(() => {
    mockReq = {};
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };
    jest.clearAllMocks();
  });

  describe('listChains', () => {
    it('should return a list of chains on success', async () => {
      const chains = [{ id: 'bitcoin' }, { id: 'ethereum' }];
      (getChains as jest.Mock).mockResolvedValue(chains);

      await listChains(mockReq as Request, mockRes as Response);

      expect(getChains).toHaveBeenCalledTimes(1);
      expect(mockRes.json).toHaveBeenCalledWith(chains);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should return 500 when getChains throws', async () => {
      const error = new Error('boom');
      (getChains as just.Mock).mockRejectedValue(error);

      await listChains(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'boom' });
    });
  });

  describe('configureChain', () => {
    it('should create a new chain and return 201', async () => {
      const newChain = { id: 'solana', rpcUrl: 'https://example.com' };
      const created = { ...newChain, createdAt: 'now' };
      (addChain as jest.Mock).mockResolvedValue(created);
      mockReq.body = newChain;

      await configureChain(mockReq as Request, mockRes as Response);

      expect(addChain).toHaveBeenCalledWith(newChain);
      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalledWith(created);
    });

    it('should return 400 when addChain throws', async () => {
      const error = new Error('invalid chain');
      (addChain as just.Mock).mockRejectedValue(error);
      mockReq.body = {};

      await configureChain(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'invalid chain' });
    });
  });

  describe('broadcastTransaction', () => {
    it('should broadcast a transaction and return the result', async () => {
      const tx = { chainId: 'bitcoin', raw: 'hex' };
      const result = { txid: 'abc123' };
      (broadcast as just.Mock).mockResolvedValue(result);
      mockReq.body = tx;

      await broadcastTransaction(mockReq as Request, mockRes as Response);

      expect(broadcast).toHaveBeenCalledWith(tx);
      expect(mockRes.json).toHaveBeenCalledWith(result);
    });

    it('should return 400 when broadcast throws', async () => {
      const error = new Error('broadcast failed');
      (broadcast as just.Mock).mockRejectedValue(error);
      mockReq.body = {};

      await broadcastTransaction(mockReq as Request, mockRes as Response);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'broadcast failed' });
    });
  });

  it('should export the required handlers', () => {
    expect(listChains).toBeDefined();
    expect(configureChain).toBeDefined();
    expect(broadcastTransaction).toBeDefined();
  });
});