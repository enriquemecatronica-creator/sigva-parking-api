// backend/src/middleware/auth.ts

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { isAccountUsable } from '../controllers/account.controller';

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Token requerido' });
  }

  const token = authHeader.slice(7);
  let payload: { sub: string; role: string };
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!) as { sub: string; role: string };
  } catch {
    return res.status(401).json({ success: false, message: 'Token inválido o expirado' });
  }

  try {
    // Una cuenta eliminada no puede seguir usando un token que aún no vence
    if (!(await isAccountUsable(payload.sub))) {
      return res.status(401).json({ success: false, message: 'La cuenta ya no existe. Inicia sesión o regístrate de nuevo.' });
    }
  } catch (err) {
    return next(err);
  }

  (req as any).userId = payload.sub;
  (req as any).userRole = payload.role;
  next();
}
