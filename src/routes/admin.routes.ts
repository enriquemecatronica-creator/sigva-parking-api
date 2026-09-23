// backend/src/routes/admin.routes.ts
// Admin-only routes for SIGVA dashboard integration — authenticated by X-Admin-Key header

import { Router, Request, Response, NextFunction } from 'express';
import { getAdminCajones, getAdminByPlate, getAdminRecaudacionHoy, getAdminQrCodes, addAdminZoneQr, updateAdminQr, updateAdminZone } from '../controllers/admin.controller';

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

// GET /api/v1/admin/qr — QR de descarga de cada zona (para imprimir stickers/señales)
router.get('/qr', getAdminQrCodes);

// POST /api/v1/admin/zonas/:id/qr — agrega el segundo QR de una zona (máximo 2)
router.post('/zonas/:id/qr', addAdminZoneQr);

// PUT /api/v1/admin/qr/:code — etiqueta / dónde quedó instalado el sticker
router.put('/qr/:code', updateAdminQr);

// PUT /api/v1/admin/zonas/:id — centro y radio GPS de la zona
router.put('/zonas/:id', updateAdminZone);

export default router;
