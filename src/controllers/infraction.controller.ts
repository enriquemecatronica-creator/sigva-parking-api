// backend/src/controllers/infraction.controller.ts
// Infracciones registradas por el inspector desde el dashboard SIGVA (X-Admin-Key).

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { remainingMinutes } from '../lib/parking';

const TYPES = ['SIN_PAGO', 'TIEMPO_VENCIDO', 'OTRA'] as const;
const STATUSES = { pendiente: 'PENDIENTE', pagada: 'PAGADA', cancelada: 'CANCELADA' } as const;

export function folio(n: number) {
  return `INF-${String(n).padStart(6, '0')}`;
}

function defaultAmount(): number | null {
  const v = Number(process.env.INFRACCION_MONTO);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function dto(i: any) {
  return {
    folio: folio(i.number),
    placa: i.licensePlate,
    tipo: i.type.toLowerCase(),
    estado: i.status.toLowerCase(),
    monto: i.amount,
    notas: i.notes,
    zona: i.zone?.name ?? null,
    cajon: i.spot?.number ?? null,
    spotId: i.spotId,
    ticketId: i.ticketId,
    registradaPor: i.issuedBy,
    fecha: i.createdAt,
  };
}

// ─── POST /admin/infracciones ─────────────────────────────────────────────────
// Body: { placa, spotId?, tipo?: 'sin_pago'|'tiempo_vencido'|'otra', monto?, notas? }
// Si no se manda tipo: con ticket activo vencido → tiempo_vencido; si no → sin_pago.
// Evita duplicados: misma placa con infracción pendiente en la última hora → 409.
export async function createInfraction(req: Request, res: Response, next: NextFunction) {
  try {
    const { placa, spotId, tipo, monto, notas } = req.body ?? {};
    const plate = typeof placa === 'string' ? placa.trim().toUpperCase().replace(/\s+/g, '') : '';
    if (plate.length < 5 || plate.length > 10) {
      return res.status(400).json({ success: false, message: 'Placa inválida (5 a 10 caracteres)' });
    }

    let spot = null as null | { id: string; zoneId: string };
    if (spotId) {
      spot = await prisma.parkingSpot.findUnique({ where: { id: String(spotId) }, select: { id: true, zoneId: true } });
      if (!spot) return res.status(404).json({ success: false, message: 'Cajón no encontrado' });
    }

    const active = await prisma.parkingTicket.findFirst({
      where: { licensePlate: plate, status: 'ACTIVE' },
      include: { spot: { select: { id: true, zoneId: true } } },
    });
    const left = active ? remainingMinutes(active.scheduledEnd) : null;
    if (active && (left == null || left > 0) && !tipo) {
      return res.status(409).json({
        success: false,
        message: `La placa ${plate} tiene una sesión pagada vigente${left != null ? ` (${left} min restantes)` : ''}.`,
      });
    }
    if (!spot && active) spot = active.spot;

    let type: (typeof TYPES)[number] = active && left != null && left <= 0 ? 'TIEMPO_VENCIDO' : 'SIN_PAGO';
    if (tipo != null) {
      const t = String(tipo).toUpperCase();
      if (!TYPES.includes(t as any)) return res.status(400).json({ success: false, message: 'Tipo inválido' });
      type = t as (typeof TYPES)[number];
    }

    let amount = defaultAmount();
    if (monto != null) {
      const m = Number(monto);
      if (!Number.isFinite(m) || m < 0 || m > 100000) return res.status(400).json({ success: false, message: 'Monto inválido' });
      amount = m;
    }

    const recent = await prisma.infraction.findFirst({
      where: { licensePlate: plate, status: 'PENDIENTE', createdAt: { gte: new Date(Date.now() - 60 * 60000) } },
      include: { spot: true, zone: true },
    });
    if (recent) {
      return res.status(409).json({
        success: false,
        message: `Ya existe la infracción ${folio(recent.number)} para ${plate} en la última hora`,
        data: dto(recent),
      });
    }

    const created = await prisma.infraction.create({
      data: {
        licensePlate: plate,
        type,
        amount,
        notes: typeof notas === 'string' ? notas.trim().slice(0, 500) || null : null,
        spotId: spot?.id ?? null,
        zoneId: spot?.zoneId ?? null,
        ticketId: active?.id ?? null,
        // Usuario del SIGVA que la registró (lo manda el puente /parking-proxy)
        issuedBy: typeof req.headers?.['x-sigva-user'] === 'string' ? `sigva:${String(req.headers['x-sigva-user']).slice(0, 80)}` : 'dashboard',
      },
      include: { spot: true, zone: true },
    });
    res.status(201).json({ success: true, data: dto(created) });
  } catch (err) {
    next(err);
  }
}

// ─── GET /admin/infracciones?desde=YYYY-MM-DD&placa= ──────────────────────────
// Por defecto las de hoy. Incluye totales para el dashboard.
export async function listInfractions(req: Request, res: Response, next: NextFunction) {
  try {
    let from = new Date();
    from.setHours(0, 0, 0, 0);
    if (typeof req.query.desde === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde)) {
      from = new Date(`${req.query.desde}T00:00:00`);
    }
    const plate = typeof req.query.placa === 'string' ? req.query.placa.trim().toUpperCase().replace(/\s+/g, '') : '';

    const items = await prisma.infraction.findMany({
      where: { createdAt: { gte: from }, ...(plate ? { licensePlate: plate } : {}) },
      include: { spot: true, zone: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const pendientes = items.filter((i) => i.status === 'PENDIENTE');
    res.json({
      success: true,
      data: items.map(dto),
      resumen: {
        total: items.length,
        pendientes: pendientes.length,
        montoPendiente: pendientes.reduce((s, i) => s + (i.amount ?? 0), 0),
        montoDefinido: defaultAmount() != null,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── PATCH /admin/infracciones/:folio ─────────────────────────────────────────
// Body: { estado: 'pagada' | 'cancelada' | 'pendiente', notas? }
export async function updateInfraction(req: Request, res: Response, next: NextFunction) {
  try {
    const m = String(req.params.folio).toUpperCase().match(/^(?:INF-)?0*(\d{1,9})$/);
    if (!m) return res.status(400).json({ success: false, message: 'Folio inválido' });
    const current = await prisma.infraction.findUnique({ where: { number: Number(m[1]) } });
    if (!current) return res.status(404).json({ success: false, message: 'Infracción no encontrada' });

    const estado = String(req.body?.estado ?? '').toLowerCase() as keyof typeof STATUSES;
    if (!STATUSES[estado]) return res.status(400).json({ success: false, message: "estado debe ser 'pagada', 'cancelada' o 'pendiente'" });

    const notes = typeof req.body?.notas === 'string' ? req.body.notas.trim().slice(0, 500) : undefined;
    const updated = await prisma.infraction.update({
      where: { id: current.id },
      data: { status: STATUSES[estado], ...(notes !== undefined ? { notes } : {}) },
      include: { spot: true, zone: true },
    });
    res.json({ success: true, data: dto(updated) });
  } catch (err) {
    next(err);
  }
}
