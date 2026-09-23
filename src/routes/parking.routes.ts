// backend/src/routes/parking.routes.ts

import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
  getZones,
  getZoneById,
  getActiveTicket,
  getTicketHistory,
  createTicket,
  closeTicket,
  extendTicket,
  getNearbyZones,
  verifyLocation,
  getParkingConfig,
} from '../controllers/parking.controller';

const router = Router();

// Todas las rutas de parking requieren autenticación
router.use(authenticate);

// GET /api/v1/parking/config — reglas de tiempo y GPS para la app
router.get('/config', getParkingConfig);

// GET /api/v1/parking/zonas-cercanas?lat=&lng=&accuracy= — zona actual por GPS
router.get('/zonas-cercanas', getNearbyZones);

// POST /api/v1/parking/verificar-ubicacion — GPS vs zona (Haversine + radio)
router.post('/verificar-ubicacion', verifyLocation);

// POST /api/v1/parking/tickets/:id/extend — agregar tiempo a la sesión
router.post('/tickets/:id/extend', extendTicket);

// GET /api/v1/parking/zones
router.get('/zones', getZones);

// GET /api/v1/parking/zones/:id
router.get('/zones/:id', getZoneById);

// GET /api/v1/parking/tickets/active
router.get('/tickets/active', getActiveTicket);

// GET /api/v1/parking/tickets/history
router.get('/tickets/history', getTicketHistory);

// POST /api/v1/parking/tickets
router.post('/tickets', createTicket);

// POST /api/v1/parking/tickets/:id/close
router.post('/tickets/:id/close', closeTicket);

export default router;
