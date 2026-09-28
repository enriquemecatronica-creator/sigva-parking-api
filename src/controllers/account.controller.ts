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

// ─── Eliminar cuenta ──────────────────────────────────────────────────────────
// Lo exigen App Store y Google Play. Se borran los datos personales (nombre,
// correo, teléfono, placas guardadas y contraseña) y la cuenta queda inutilizable.
// Los tickets y pagos se conservan, sin datos de contacto, para aclaraciones,
// infracciones ya levantadas y la contabilidad de la recaudación.

type DeleteResult = { status: number; message: string };

async function eliminarUsuario(user: any, password: unknown): Promise<DeleteResult> {
  if (!user || user.deletedAt) return { status: 404, message: 'La cuenta no existe o ya fue eliminada' };
  if (String(user.role) !== 'DRIVER') {
    return { status: 403, message: 'Las cuentas de operador o administrador se dan de baja desde SIGVA' };
  }
  if (typeof password !== 'string' || !(await bcrypt.compare(password, user.password))) {
    return { status: 400, message: 'La contraseña no es correcta' };
  }
  const activa = await prisma.parkingTicket.findFirst({
    where: { userId: user.id, status: { in: ['ACTIVE', 'PENDING_PAYMENT'] } },
  });
  if (activa) {
    return { status: 409, message: 'Tienes una sesión de estacionamiento activa o pendiente de pago. Termínala antes de eliminar tu cuenta.' };
  }
  await prisma.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.user.update({
    where: { id: user.id },
    data: {
      name: 'Cuenta eliminada',
      email: `eliminada-${user.id}@sigva.invalid`,
      phone: null,
      savedPlates: [],
      password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      deletedAt: new Date(),
    },
  });
  forgetAccountStatus(user.id);
  return { status: 200, message: 'Tu cuenta se eliminó. Gracias por usar SIGVA Parquímetro.' };
}

// DELETE /auth/me  (desde la app, con sesión)  Body: { password }
export async function deleteAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({ where: { id: (req as any).userId } });
    const r = await eliminarUsuario(user, req.body?.password);
    res.status(r.status).json({ success: r.status === 200, message: r.message });
  } catch (err) {
    next(err);
  }
}

// GET/POST /eliminar-cuenta  (página web pública; Google Play pide un enlace así)
export function deleteAccountPage(req: Request, res: Response, next: NextFunction) {
  const render = (msg?: { ok: boolean; text: string }) =>
    res.type('html').send(legalShell('Eliminar mi cuenta', `
<p>Puedes eliminar tu cuenta de <b>SIGVA Parquímetro</b> desde la app (<b>Perfil → Mi cuenta → Eliminar mi cuenta</b>) o con este formulario.</p>
<p>Se borran tu nombre, correo, teléfono, placas guardadas y contraseña. Los registros de tus sesiones y pagos se conservan sin tus datos de contacto para aclaraciones, infracciones ya levantadas y obligaciones contables.</p>
${msg ? `<p class="${msg.ok ? 'ok' : 'err'}">${escapeHtml(msg.text)}</p>` : ''}
${msg?.ok ? '' : `<form method="post" action="/eliminar-cuenta">
  <label for="email">Correo de tu cuenta</label>
  <input id="email" name="email" type="email" autocomplete="email" required>
  <label for="password">Contraseña</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Eliminar mi cuenta definitivamente</button>
</form>`}`));

  if (req.method !== 'POST') return render();
  (async () => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const user = email ? await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } }) : null;
    // Mismo mensaje si el correo no existe o la contraseña es incorrecta
    const r = user ? await eliminarUsuario(user, req.body?.password) : { status: 400, message: '' };
    const text = r.status === 200 || r.status === 409 || r.status === 403 ? r.message : 'El correo o la contraseña no son correctos.';
    res.status(r.status === 200 ? 200 : r.status === 409 || r.status === 403 ? r.status : 400);
    render({ ok: r.status === 200, text });
  })().catch(next);
}

// ─── Cuentas eliminadas: bloquear tokens que sigan vigentes ────────────────────
// El middleware de autenticación consulta esto (con caché de 60 s por usuario).
const statusCache = new Map<string, { ok: boolean; exp: number }>();

export async function isAccountUsable(userId: string): Promise<boolean> {
  const hit = statusCache.get(userId);
  if (hit && hit.exp > Date.now()) return hit.ok;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, deletedAt: true } });
  const ok = !!u && !u.deletedAt;
  statusCache.set(userId, { ok, exp: Date.now() + 60_000 });
  if (statusCache.size > 5000) statusCache.clear();
  return ok;
}

function forgetAccountStatus(userId: string) {
  statusCache.set(userId, { ok: false, exp: Date.now() + 60_000 });
}

// ─── Plantilla de páginas públicas (privacidad, términos, eliminar cuenta) ────
export function legalShell(title: string, body: string) {
  return `<!doctype html>
<html lang="es-MX"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · SIGVA Parquímetro</title>
<style>
  :root{--bg:#f6f7fb;--card:#fff;--ink:#16223a;--muted:#55627a;--line:#dfe4ee;--accent:#1e40af;--ok:#047857;--err:#b91c1c}
  @media (prefers-color-scheme:dark){:root{--bg:#0b1220;--card:#121b2e;--ink:#e6edf7;--muted:#9fb0c8;--line:#24324d;--accent:#7aa2ff;--ok:#34d399;--err:#f87171}}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px 16px}
  main{max-width:720px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px 20px}
  h1{font-size:24px;line-height:1.25;margin:0 0 4px}
  h2{font-size:18px;margin:28px 0 8px}
  .meta{color:var(--muted);font-size:14px;margin:0 0 20px}
  .draft{background:#fef3c7;color:#78350f;border-radius:8px;padding:10px 12px;font-size:14px}
  a{color:var(--accent)}
  ul{padding-left:20px}
  label{display:block;font-weight:600;margin:14px 0 4px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--bg);color:var(--ink)}
  button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--err);color:#fff;font:inherit;font-weight:700;cursor:pointer}
  .ok{color:var(--ok);font-weight:600}.err{color:var(--err);font-weight:600}
  footer{max-width:720px;margin:16px auto 0;color:var(--muted);font-size:13px;text-align:center}
</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main>
<footer><a href="/privacidad">Aviso de privacidad</a> · <a href="/terminos">Términos de uso</a> · <a href="/eliminar-cuenta">Eliminar mi cuenta</a></footer>
</body></html>`;
}
