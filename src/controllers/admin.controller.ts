// backend/src/controllers/admin.controller.ts
// Admin endpoints for SIGVA dashboard — secured by X-Admin-Key header

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { MAX_QR_PER_ZONE, downloadUrlFor, addSecondZoneQr, normalizeQrCode, remainingMinutes } from '../lib/parking';
import { autoReleaseConfig, minutesUntilRelease } from '../lib/autoRelease';

// ─── GET /admin/cajones ───────────────────────────────────────────────────────
// Returns all spots with real-time status for the Parquímetro module in SIGVA
export async function getAdminCajones(req: Request, res: Response, next: NextFunction) {
  try {
    const spots = await prisma.parkingSpot.findMany({
      include: {
        zone: true,
        tickets: {
          where: { status: 'ACTIVE' },
          include: { user: { select: { name: true } } },
          take: 1,
        },
      },
      orderBy: [{ zone: { name: 'asc' } }, { number: 'asc' }],
    });

    const now = Date.now();

    const cajones = spots.map((spot) => {
      const activeTicket = spot.tickets[0] ?? null;
      const minutosEstacionado = activeTicket
        ? Math.floor((now - activeTicket.entryTime.getTime()) / 60000)
        : null;

      const minutosRestantes = activeTicket ? remainingMinutes(activeTicket.scheduledEnd, now) : null;
      const vencido = minutosRestantes != null && minutosRestantes <= 0;

      let estado: string;
      switch (spot.status) {
        case 'FREE':
          estado = 'libre';
          break;
        case 'OCCUPIED':
          // Tiempo contratado vencido → el inspector debe revisar
          estado = vencido ? 'ocupado_sin_pago' : 'ocupado_pagado';
          break;
        case 'RESERVED':
          estado = 'reservado';
          break;
        case 'DISABLED':
          estado = 'offline';
          break;
        default:
          estado = 'libre';
      }

      return {
        id: spot.number,
        spotId: spot.id,
        zoneId: spot.zoneId,
        zona: spot.zone.name,
        estado,
        placa: activeTicket?.licensePlate ?? null,
        conductor: activeTicket?.user?.name ?? null,
        minutosEstacionado,
        minutosRestantes,
        vencido,
        // Vencidos: minutos antes de que el sistema libere el cajón solo (null si no aplica)
        minutosParaLiberar: vencido ? minutesUntilRelease(minutosRestantes) : null,
      };
    });

    res.json({ success: true, data: cajones, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
}

// ─── GET /admin/inspector/:placa ──────────────────────────────────────────────
// Returns active ticket info for a given license plate (inspector tab)
export async function getAdminByPlate(req: Request, res: Response, next: NextFunction) {
  try {
    const placa = String(req.params.placa).toUpperCase().replace(/\s/g, '');

    const ticket = await prisma.parkingTicket.findFirst({
      where: { licensePlate: placa, status: 'ACTIVE' },
      include: {
        spot: { include: { zone: true } },
        user: { select: { name: true, email: true } },
      },
    });

    if (!ticket) {
      return res.json({ success: true, data: null, message: 'Placa no tiene ticket activo' });
    }

    const now = Date.now();
    const minutosEstacionado = Math.floor((now - ticket.entryTime.getTime()) / 60000);
    const horas = minutosEstacionado / 60;
    const montoEstimado = Math.max(
      parseFloat((horas * ticket.spot.zone.ratePerHour).toFixed(2)),
      ticket.spot.zone.ratePerHour / 4
    );

    const minutosRestantes = remainingMinutes(ticket.scheduledEnd, now);

    res.json({
      success: true,
      data: {
        ticketId: ticket.id,
        finProgramado: ticket.scheduledEnd,
        minutosRestantes,
        vencido: minutosRestantes != null && minutosRestantes <= 0,
        montoPagado: ticket.amountPaid,
        placa: ticket.licensePlate,
        conductor: ticket.user?.name ?? 'Desconocido',
        cajon: ticket.spot.number,
        zona: ticket.spot.zone.name,
        entryTime: ticket.entryTime,
        minutosEstacionado,
        montoEstimado,
        currency: 'MXN',
        qrCode: ticket.qrCode,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /admin/recaudacion/hoy ───────────────────────────────────────────────
// Returns today's revenue breakdown for the SIGVA dashboard
export async function getAdminRecaudacionHoy(req: Request, res: Response, next: NextFunction) {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const tickets = await prisma.parkingTicket.findMany({
      where: {
        status: 'COMPLETED',
        exitTime: { gte: todayStart },
      },
      include: {
        spot: { include: { zone: true } },
      },
    });

    const total = tickets.reduce((sum, t) => sum + (t.amountPaid ?? 0), 0);
    const sesiones = tickets.length;

    // Breakdown by payment method
    const tarjeta = tickets
      .filter((t) => t.paymentMethod === 'CARD')
      .reduce((sum, t) => sum + (t.amountPaid ?? 0), 0);
    const codi = tickets
      .filter((t) => t.paymentMethod === 'QR')
      .reduce((sum, t) => sum + (t.amountPaid ?? 0), 0);
    const oxxo = tickets
      .filter((t) => t.paymentMethod === 'WALLET')
      .reduce((sum, t) => sum + (t.amountPaid ?? 0), 0);

    // Breakdown by zone
    const zonaMap: Record<string, number> = {};
    for (const t of tickets) {
      const zoneName = t.spot.zone.name;
      zonaMap[zoneName] = (zonaMap[zoneName] ?? 0) + (t.amountPaid ?? 0);
    }
    const porZona = Object.entries(zonaMap).map(([zona, monto]) => ({ zona, monto }));

    // Monthly projection (30-day simple estimate based on today)
    const hourOfDay = new Date().getHours() || 1;
    const proyeccionDiaria = hourOfDay >= 8 ? (total / (hourOfDay - 7)) * 12 : total; // operating 8am-8pm
    const proyeccionMensual = parseFloat((proyeccionDiaria * 26).toFixed(2)); // 26 business days

    res.json({
      success: true,
      data: {
        total: parseFloat(total.toFixed(2)),
        tarjeta: parseFloat(tarjeta.toFixed(2)),
        codi: parseFloat(codi.toFixed(2)),
        oxxo: parseFloat(oxxo.toFixed(2)),
        sesiones,
        porZona,
        proyeccionMensual,
        currency: 'MXN',
        fecha: todayStart.toISOString().split('T')[0],
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /admin/qr ────────────────────────────────────────────────────────────
// QR de descarga de cada zona (1 o máximo 2) para imprimir los stickers/señales
export async function getAdminQrCodes(req: Request, res: Response, next: NextFunction) {
  try {
    const qrs = await prisma.zoneQr.findMany({
      include: { zone: { select: { name: true, address: true, latitude: true, longitude: true } } },
      orderBy: { code: 'asc' },
    });
    res.json({
      success: true,
      data: qrs.map((q) => ({
        codigo: q.code,
        contenido: downloadUrlFor(q.code, `${req.protocol}://${req.get('host')}`),
        etiqueta: q.label,
        zona: q.zone.name,
        direccion: q.zone.address,
        latitudInstalacion: q.latitude,
        longitudInstalacion: q.longitude,
        activo: q.isActive,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /admin/zonas/:id/qr ─────────────────────────────────────────────────
// Agrega el segundo QR de una zona (máximo 2). Body opcional: { etiqueta }
export async function addAdminZoneQr(req: Request, res: Response, next: NextFunction) {
  try {
    const zone = await prisma.parkingZone.findUnique({ where: { id: String(req.params.id) } });
    if (!zone) return res.status(404).json({ success: false, message: 'Zona no encontrada' });
    const qr = await addSecondZoneQr(zone.id, req.body?.etiqueta);
    if (!qr) {
      return res.status(409).json({ success: false, message: `La zona ya tiene el máximo de ${MAX_QR_PER_ZONE} QR` });
    }
    res.status(201).json({ success: true, data: { codigo: qr.code, contenido: downloadUrlFor(qr.code, `${req.protocol}://${req.get('host')}`), zona: zone.name } });
  } catch (err) {
    next(err);
  }
}

// ─── PUT /admin/qr/:code ──────────────────────────────────────────────────────
// Registra dónde quedó instalado el sticker QR (informativo) y su etiqueta.
// Body: { latitud?, longitud?, etiqueta?, activo? }
export async function updateAdminQr(req: Request, res: Response, next: NextFunction) {
  try {
    const code = normalizeQrCode(String(req.params.code));
    const qr = code ? await prisma.zoneQr.findUnique({ where: { code } }) : null;
    if (!qr) return res.status(404).json({ success: false, message: 'QR no encontrado' });

    const { latitud, longitud, etiqueta, activo } = req.body ?? {};
    const data: { latitude?: number; longitude?: number; label?: string; isActive?: boolean } = {};
    if (latitud != null || longitud != null) {
      const lat = Number(latitud), lng = Number(longitud);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return res.status(400).json({ success: false, message: 'Latitud y longitud deben ser números válidos' });
      }
      data.latitude = lat;
      data.longitude = lng;
    }
    if (typeof etiqueta === 'string') data.label = etiqueta.trim().slice(0, 80);
    if (typeof activo === 'boolean') data.isActive = activo;

    const updated = await prisma.zoneQr.update({ where: { id: qr.id }, data });
    res.json({ success: true, data: { codigo: updated.code, latitud: updated.latitude, longitud: updated.longitude, etiqueta: updated.label, activo: updated.isActive } });
  } catch (err) {
    next(err);
  }
}

// ─── PUT /admin/zonas/:id ─────────────────────────────────────────────────────
// Actualiza el centro y el radio de una zona (cuando se tengan las coordenadas reales).
// Body: { latitud?, longitud?, radioM? }
export async function updateAdminZone(req: Request, res: Response, next: NextFunction) {
  try {
    const zone = await prisma.parkingZone.findUnique({ where: { id: String(req.params.id) } });
    if (!zone) return res.status(404).json({ success: false, message: 'Zona no encontrada' });

    const { latitud, longitud, radioM } = req.body ?? {};
    const data: { latitude?: number; longitude?: number; radiusM?: number } = {};
    if (latitud != null || longitud != null) {
      const lat = Number(latitud), lng = Number(longitud);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return res.status(400).json({ success: false, message: 'Latitud y longitud deben ser números válidos' });
      }
      data.latitude = lat;
      data.longitude = lng;
    }
    if (radioM != null) {
      const r = Number(radioM);
      if (!Number.isInteger(r) || r < 20 || r > 1000) {
        return res.status(400).json({ success: false, message: 'radioM debe ser un entero entre 20 y 1000' });
      }
      data.radiusM = r;
    }
    const updated = await prisma.parkingZone.update({ where: { id: zone.id }, data });
    res.json({ success: true, data: { id: updated.id, zona: updated.name, latitud: updated.latitude, longitud: updated.longitude, radioM: updated.radiusM } });
  } catch (err) {
    next(err);
  }
}

// ─── GET /admin/version ───────────────────────────────────────────────────────
// Consulta muy ligera para el dashboard: cambia cada vez que se mueve un cajón, un ticket
// o una infracción. El dashboard la pregunta cada pocos segundos y solo recarga si cambió.
export async function getAdminVersion(_req: Request, res: Response, next: NextFunction) {
  try {
    const [spots, tickets, infractions, activos] = await Promise.all([
      prisma.parkingSpot.aggregate({ _max: { updatedAt: true } }),
      prisma.parkingTicket.aggregate({ _max: { updatedAt: true } }),
      prisma.infraction.aggregate({ _max: { updatedAt: true } }),
      prisma.parkingTicket.count({ where: { status: 'ACTIVE' } }),
    ]);
    const ms = (d: Date | null | undefined) => (d ? d.getTime() : 0);
    const version = [ms(spots._max.updatedAt), ms(tickets._max.updatedAt), ms(infractions._max.updatedAt), activos].join('-');
    res.json({
      success: true,
      data: { version, activos, liberacionAutomaticaMin: autoReleaseConfig.minutes, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
}
