// backend/src/app.ts — Configuración Express

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import authRouter from './routes/auth.routes';
import parkingRouter from './routes/parking.routes';
import adminRouter from './routes/admin.routes';
import downloadRouter from './routes/download.routes';
import { errorHandler } from './middleware/errorHandler';

const app = express();

// Railway pone un proxy delante: sin esto todos los usuarios comparten el mismo
// límite de solicitudes (misma IP) y req.protocol sale 'http' en vez de 'https'.
app.set('trust proxy', 1);

// ─── Seguridad ────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') ?? '*',
  credentials: true,
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  message: { success: false, message: 'Demasiadas solicitudes, intenta más tarde' },
});
app.use('/api/', limiter);

// ─── Parsers ──────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'SIGVA Parking API', version: '1.0.0' });
});

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/parking', parkingRouter);
app.use('/api/v1/admin', adminRouter);   // Dashboard SIGVA — requiere X-Admin-Key
app.use('/descargar', downloadRouter);    // Destino de los QR de zona (solo descarga de la app)

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Ruta no encontrada' });
});

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

export default app;
