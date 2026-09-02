import { Request, Response, NextFunction } from 'express';

const defaultTimeout = parseInt(process.env.REQUEST_TIMEOUT_MS || '30000', 10);
const adminTimeout = parseInt(process.env.ADMIN_REQUEST_TIMEOUT_MS || '60000', 10);

export default function requestTimeout(req, res, next) {
  const timeoutMs = req.path.startsWith('/admin') ? adminTimeout : defaultTimeout;
  const timer = setTimeout(() => {
    if (!res.headersSent) res.status(408).json({ error: 'Request Timeout' });
    req.destroy();
  }, timeoutMs);
  res.on('finish', () => clearTimeout(timer));
  next();
}