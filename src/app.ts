// backend/src/app.ts — Configuración Express

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';

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
// • Dashboard SIGVA (X-Admin-Key válida): sin límite; consulta cada 30 s desde varias pestañas.
// • App: límite por usuario (JWT), no por IP; muchos conductores comparten IP (oficina, red celular).
// • Login/registro: límite estricto por IP contra intentos de adivinar contraseñas.
function isAdminRequest(req: express.Request) {
  const key = process.env.ADMIN_API_KEY;
  return !!key && req.headers['x-admin-key'] === key;
}

function userOrIpKey(req: express.Request) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && process.env.JWT_SECRET) {
    try {
      const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET) as { sub?: string };
      if (payload?.sub) return `u:${payload.sub}`;
    } catch {
      // token inválido o vencido → se cuenta por IP
    }
  }
  return `ip:${req.ip}`;
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiados intentos de acceso, intenta en 15 minutos' },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  skip: isAdminRequest,
  message: { success: false, message: 'Demasiadas solicitudes, intenta más tarde' },
});

app.use('/api/v1/auth/login', authLimiter);
app.use('/api/v1/auth/register', authLimiter);
app.use('/api/', apiLimiter);

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
