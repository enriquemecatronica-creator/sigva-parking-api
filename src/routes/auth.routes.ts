// backend/src/routes/auth.routes.ts

import { Router } from 'express';
import { register, login, refreshToken, me } from '../controllers/auth.controller';
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

export default router;
