// backend/src/routes/admin.routes.ts
// Admin-only routes for SIGVA dashboard integration — authenticated by X-Admin-Key header

import { Router, Request, Response, NextFunction } from 'express';
import { getAdminCajones, getAdminByPlate, getAdminRecaudacionHoy } from '../controllers/admin.controller';

const router = Router();

// ─── Middleware: X-Admin-Key validation ──────────────────────────────────────
function requireAdminKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_API_KEY;

  if (!expected) {
    // If not set, deny all — forces explicit configuration
    return res.status(500).json({ success: false, message: 'Admin key not configured' });
  }

  if (!key || key !== expected) {
    return res.status(401).json({ success: false, message: 'Clave de administrador inválida' });
  }

  next();
}

router.use(requireAdminKey);

// GET /api/v1/admin/cajones — all spots with real-time status
router.get('/cajones', getAdminCajones);

// GET /api/v1/admin/inspector/:placa — lookup active ticket by license plate
router.get('/inspector/:placa', getAdminByPlate);

// GET /api/v1/admin/recaudacion/hoy — today's revenue stats
router.get('/recaudacion/hoy', getAdminRecaudacionHoy);

export default router;
