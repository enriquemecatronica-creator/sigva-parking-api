// backend/src/routes/auth.routes.ts

import { Router } from 'express';
import { register, login, refreshToken, me } from '../controllers/auth.controller';
import { updateMe, getAccount, changePassword, forgotPassword, resetPassword } from '../controllers/account.controller';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { loginSchema, registerSchema } from '../schemas/auth.schema';

const router = Router();

// POST /api/v1/auth/register
router.post('/register', validate(registerSchema), register);

// POST /api/v1/auth/login
router.post('/login', validate(loginSchema), login);

// POST /api/v1/auth/refresh
router.post('/refresh', refreshToken);

// GET /api/v1/auth/me   (requiere JWT)
router.get('/me', authenticate, me);

// Mi cuenta (requiere JWT)
router.get('/cuenta', authenticate, getAccount);            // datos + placas guardadas
router.put('/me', authenticate, updateMe);                  // nombre, teléfono, placas
router.post('/change-password', authenticate, changePassword);

// Recuperar contraseña con código al correo (requiere RESEND_API_KEY y MAIL_FROM)
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

export default router;
