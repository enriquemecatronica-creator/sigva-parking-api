// backend/src/schemas/auth.schema.ts

import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email('Correo inválido'),
  password: z.string().min(1, 'Contraseña requerida'),
});

export const registerSchema = z.object({
  name: z.string().min(2, 'Nombre muy corto').max(100),
  email: z.string().email('Correo inválido'),
  phone: z.string().min(10, 'Teléfono inválido').max(20).optional(),
  password: z.string().min(8, 'Mínimo 8 caracteres'),
});
