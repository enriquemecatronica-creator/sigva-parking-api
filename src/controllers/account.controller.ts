// backend/src/controllers/account.controller.ts
// "Mi cuenta" en la app: editar datos, placas guardadas, cambiar contraseña
// y recuperar contraseña con un código de 6 dígitos enviado al correo.

import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { mailConfig, sendMail } from '../lib/mailer';

const CODE_TTL_MIN = 15;
const MAX_ATTEMPTS = 5;
const RESEND_WAIT_S = 60;
const MAX_PLATES = 5;

const userSelect = { id: true, name: true, email: true, phone: true, role: true, createdAt: true, savedPlates: true } as const;

function userDto(u: any) {
  const { savedPlates, ...rest } = u;
  return { ...rest, role: String(u.role).toLowerCase(), placas: savedPlates ?? [] };
}

export function normalizePlate(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const s = p.trim().toUpperCase().replace(/[\s-]+/g, '');
  return /^[A-Z0-9]{5,10}$/.test(s) ? s : null;
}

function hashCode(userId: string, code: string) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'sigva').update(`${userId}:${code}`).digest('hex');
}

// ─── PUT /auth/me ─────────────────────────────────────────────────────────────
// Body: { name?, phone?, placas? }  (placas: arreglo de hasta 5)
export async function updateMe(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).userId;
    const { name, phone, placas } = req.body ?? {};
    const data: { name?: string; phone?: string | null; savedPlates?: string[] } = {};

    if (name != null) {
      const n = String(name).trim();
      if (n.length < 2 || n.length > 100) return res.status(400).json({ success: false, message: 'El nombre debe tener entre 2 y 100 caracteres' });
      data.name = n;
    }
    if (phone != null) {
      const p = String(phone).replace(/[^\d+]/g, '');
      if (p && (p.length < 10 || p.length > 15)) return res.status(400).json({ success: false, message: 'Teléfono inválido (10 dígitos)' });
      data.phone = p || null;
    }
    if (placas != null) {
      if (!Array.isArray(placas)) return res.status(400).json({ success: false, message: 'placas debe ser una lista' });
      const list: string[] = [];
      for (const raw of placas) {
        const p = normalizePlate(raw);
        if (!p) return res.status(400).json({ success: false, message: `Placa inválida: ${String(raw).slice(0, 12)}` });
        if (!list.includes(p)) list.push(p);
      }
      if (list.length > MAX_PLATES) return res.status(400).json({ success: false, message: `Máximo ${MAX_PLATES} placas guardadas` });
      data.savedPlates = list;
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ success: false, message: 'No se envió ningún cambio' });

    const user = await prisma.user.update({ where: { id: userId }, data, select: userSelect });
    res.json({ success: true, user: userDto(user) });
  } catch (err) {
    next(err);
  }
}

// ─── GET /auth/cuenta ─────────────────────────────────────────────────────────
export async function getAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({ where: { id: (req as any).userId }, select: userSelect });
    if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    res.json({ success: true, user: userDto(user), recuperacionDisponible: mailConfig.enabled });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/change-password ───────────────────────────────────────────────
// Body: { actual, nueva }
export async function changePassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { actual, nueva } = req.body ?? {};
    if (typeof nueva !== 'string' || nueva.length < 8) return res.status(400).json({ success: false, message: 'La contraseña nueva debe tener al menos 8 caracteres' });
    const user = await prisma.user.findUnique({ where: { id: (req as any).userId } });
    if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    if (typeof actual !== 'string' || !(await bcrypt.compare(actual, user.password))) {
      return res.status(400).json({ success: false, message: 'La contraseña actual no es correcta' });
    }
    await prisma.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash(nueva, 12) } });
    res.json({ success: true, message: 'Contraseña actualizada' });
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/forgot-password ───────────────────────────────────────────────
// Body: { email }. Siempre responde lo mismo (no revela si el correo existe).
export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    if (!mailConfig.enabled) {
      return res.status(503).json({ success: false, message: 'La recuperación de contraseña todavía no está disponible. Contacta al administrador.' });
    }
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const generic = { success: true, message: 'Si el correo está registrado, te enviamos un código de 6 dígitos. Revisa también tu carpeta de spam.' };
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success: false, message: 'Correo inválido' });

    const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (!user) return res.json(generic);

    const recent = await prisma.passwordReset.findFirst({
      where: { userId: user.id, usedAt: null, createdAt: { gte: new Date(Date.now() - RESEND_WAIT_S * 1000) } },
    });
    if (recent) return res.json(generic); // ya se envió uno hace menos de un minuto

    await prisma.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await prisma.passwordReset.create({
      data: { userId: user.id, codeHash: hashCode(user.id, code), expiresAt: new Date(Date.now() + CODE_TTL_MIN * 60000) },
    });
    await sendMail({
      to: user.email,
      subject: `Tu código para recuperar la contraseña: ${code}`,
      text: `Hola ${user.name},\n\nTu código para crear una contraseña nueva en SIGVA Parquímetro es: ${code}\n\nVence en ${CODE_TTL_MIN} minutos. Si no lo pediste, ignora este correo.`,
      html: `<p>Hola ${escapeHtml(user.name)},</p><p>Tu código para crear una contraseña nueva en <b>SIGVA Parquímetro</b> es:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>Vence en ${CODE_TTL_MIN} minutos. Si no lo pediste, ignora este correo.</p>`,
    });
    res.json(generic);
  } catch (err) {
    next(err);
  }
}

// ─── POST /auth/reset-password ────────────────────────────────────────────────
// Body: { email, codigo, nueva }
export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const codigo = typeof req.body?.codigo === 'string' ? req.body.codigo.trim() : String(req.body?.codigo ?? '');
    const nueva = req.body?.nueva;
    const invalid = () => res.status(400).json({ success: false, message: 'Código inválido o vencido. Pide uno nuevo.' });

    if (typeof nueva !== 'string' || nueva.length < 8) return res.status(400).json({ success: false, message: 'La contraseña nueva debe tener al menos 8 caracteres' });
    if (!/^\d{6}$/.test(codigo)) return invalid();

    const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (!user) return invalid();
    const reset = await prisma.passwordReset.findFirst({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!reset || reset.attempts >= MAX_ATTEMPTS) return invalid();

    const ok = crypto.timingSafeEqual(Buffer.from(reset.codeHash), Buffer.from(hashCode(user.id, codigo)));
    if (!ok) {
      await prisma.passwordReset.update({ where: { id: reset.id }, data: { attempts: reset.attempts + 1 } });
      return invalid();
    }
    await prisma.user.update({ where: { id: user.id }, data: { password: await bcrypt.hash(nueva, 12) } });
    await prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } });
    res.json({ success: true, message: 'Listo, ya puedes iniciar sesión con tu contraseña nueva' });
  } catch (err) {
    next(err);
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
