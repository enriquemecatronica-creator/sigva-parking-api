// backend/src/middleware/errorHandler.ts

import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  console.error('[ERROR]', err);

  if (err.code === 'P2002') {
    return res.status(409).json({ success: false, message: 'Registro duplicado' });
  }

  const status = err.statusCode ?? err.status ?? 500;
  const message = err.message ?? 'Error interno del servidor';
  res.status(status).json({ success: false, message });
}
