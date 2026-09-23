// backend/src/controllers/parking.controller.ts

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import crypto from 'crypto';
import {
  costFor,
  evaluateGps,
  parkingConfig,
  remainingMinutes,
  validateMinutes,
  zonesByDistance,
} from '../lib/parking';

type AuthReq = Request & { userId: string };

// Punto contra el que se valida el GPS: centro y radio de la zona.
function zoneTarget(zone: { latitude: number; longitude: number; radiusM: number }) {
  return { lat: zone.latitude, lng: zone.longitude, radiusM: zone.radiusM };
}

function ticketDto(t: any, spot: any) {
  return {
    id: t.id,
    userId: t.userId,
    spotId: t.spotId,
    zoneId: spot.zoneId,
    zoneName: spot.zone.name,
    spotNumber: spot.number,
    status: t.status.toLowerCase(),
    entryTime: t.entryTime,
    exitTime: t.exitTime ?? null,
    plannedMinutes: t.plannedMinutes ?? null,
    scheduledEnd: t.scheduledEnd ?? null,
    remainingMinutes: t.status === 'ACTIVE' ? remainingMinutes(t.scheduledEnd) : null,
    durationMinutes: t.durationMinutes ?? null,
    amountDue: t.amountDue ?? null,
    amountPaid: t.amountPaid ?? null,
    paymentMethod: t.paymentMethod?.toLowerCase() ?? null,
    ratePerHour: spot.zone.ratePerHour,
    currency: spot.zone.currency,
    licensePlate: t.licensePlate,
    qrCode: t.qrCode,
  };
}

// ─── GET /parking/config ─────────────────────────────────────────────────────
// Reglas que la app necesita para armar la pantalla de registro.
export async function getParkingConfig(_req: Request, res: Response) {
  res.json({
    success: true,
    data: {
      gpsValidationEnabled: parkingConfig.gpsEnforced,
      maxAccuracyM: parkingConfig.maxAccuracyM,
      minMinutes: parkingConfig.minMinutes,
      maxMinutes: parkingConfig.maxMinutes,
      stepMinutes: parkingConfig.stepMinutes,
    },
  });
}

// ─── GET /parking/zones ───────────────────────────────────────────────────────
export async function getZones(req: Request, res: Response, next: NextFunction) {
  try {
    const zones = await prisma.parkingZone.findMany({
      where: { isActive: true },
      // Se cuentan los cajones reales; el campo fijo totalSpots de la zona puede no coincidir
      include: { spots: { select: { status: true } } },
      orderBy: { name: 'asc' },
    });

    const result = zones.map((z) => ({
      id: z.id,
      name: z.name,
      address: z.address,
      latitude: z.latitude,
      longitude: z.longitude,
      radiusM: z.radiusM,
      totalSpots: z.spots.length,
      freeSpots: z.spots.filter((s) => s.status === 'FREE').length,
      ratePerHour: z.ratePerHour,
      currency: z.currency,
      operatingHours: { open: z.openTime, close: z.closeTime },
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ─── GET /parking/zones/:id ───────────────────────────────────────────────────
export async function getZoneById(req: Request, res: Response, next: NextFunction) {
  try {
    const zone = await prisma.parkingZone.findUnique({
      where: { id: String(req.params.id) },
      include: { spots: { orderBy: { number: 'asc' } } },
    });
    if (!zone) {
      return res.status(404).json({ success: false, message: 'Zona no encontrada' });
    }
    const freeSpots = zone.spots.filter((s) => s.status === 'FREE').length;
    res.json({
      success: true,
      data: {
        id: zone.id,
        name: zone.name,
        address: zone.address,
        latitude: zone.latitude,
        longitude: zone.longitude,
        totalSpots: zone.spots.length,
        freeSpots,
        ratePerHour: zone.ratePerHour,
        currency: zone.currency,
        operatingHours: { open: zone.openTime, close: zone.closeTime },
        spots: zone.spots.map((s) => ({
          id: s.id,
          number: s.number,
          status: s.status.toLowerCase() as 'free' | 'occupied' | 'reserved' | 'disabled',
          zoneId: s.zoneId,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /parking/zonas-cercanas?lat=&lng=&accuracy= ─────────────────────────
// La app lo llama al abrir "Estacionarme": detecta en qué zona está el teléfono
// y devuelve las zonas ordenadas por distancia, con sus cajones libres.
export async function getNearbyZones(req: Request, res: Response, next: NextFunction) {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const accuracy = req.query.accuracy == null ? null : Number(req.query.accuracy);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ success: false, message: 'lat y lng son requeridos' });
    }

    const zones = await prisma.parkingZone.findMany({
      where: { isActive: true },
      include: { spots: { orderBy: { number: 'asc' } } },
    });
    const ranked = zonesByDistance(zones, lat, lng).slice(0, 10);
    const lowAccuracy = accuracy != null && Number.isFinite(accuracy) && accuracy > parkingConfig.maxAccuracyM;
    const current = ranked.find((r) => r.inside) ?? null;

    res.json({
      success: true,
      data: {
        currentZoneId: current && !lowAccuracy ? current.zone.id : null,
        gpsValidationEnabled: parkingConfig.gpsEnforced,
        accuracyM: accuracy,
        lowAccuracy,
        maxAccuracyM: parkingConfig.maxAccuracyM,
        zones: ranked.map(({ zone, distanceM, inside }) => ({
          id: zone.id,
          name: zone.name,
          address: zone.address,
          latitude: zone.latitude,
          longitude: zone.longitude,
          radiusM: zone.radiusM,
          distanceM,
          inside,
          ratePerHour: zone.ratePerHour,
          currency: zone.currency,
          operatingHours: { open: zone.openTime, close: zone.closeTime },
          totalSpots: zone.spots.length,
          freeSpots: zone.spots.filter((s) => s.status === 'FREE').length,
          spots: zone.spots.map((s) => ({ id: s.id, number: s.number, status: s.status.toLowerCase(), available: s.status === 'FREE' })),
        })),
        rules: {
          minMinutes: parkingConfig.minMinutes,
          maxMinutes: parkingConfig.maxMinutes,
          stepMinutes: parkingConfig.stepMinutes,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /parking/verificar-ubicacion ────────────────────────────────────────
// Body: { zoneId, lat, lng, accuracy } — confirma que el teléfono está dentro de la zona.
export async function verifyLocation(req: Request, res: Response, next: NextFunction) {
  try {
    const { zoneId, lat, lng, accuracy } = req.body ?? {};
    const zone = zoneId ? await prisma.parkingZone.findUnique({ where: { id: String(zoneId) } }) : null;
    if (!zone || !zone.isActive) {
      return res.status(404).json({ success: false, message: 'Zona no encontrada' });
    }
    const gps = evaluateGps({ lat, lng, accuracy }, zoneTarget(zone));
    const payload = {
      ok: gps.ok,
      enforced: gps.enforced,
      distanceM: gps.distanceM,
      accuracyM: gps.accuracyM,
      radiusM: zone.radiusM,
      maxAccuracyM: parkingConfig.maxAccuracyM,
      warning: gps.reason,
    };
    if (!gps.ok) {
      return res.status(400).json({ success: false, message: gps.reason, data: payload });
    }
    res.json({ success: true, data: payload });
  } catch (err) {
    next(err);
  }
}

// ─── GET /parking/tickets/active ─────────────────────────────────────────────
export async function getActiveTicket(req: AuthReq | any, res: Response, next: NextFunction) {
  try {
    const ticket = await prisma.parkingTicket.findFirst({
      where: { userId: req.userId, status: 'ACTIVE' },
      include: {
        spot: { include: { zone: true } },
      },
    });

    if (!ticket) {
      return res.json({ success: true, data: null });
    }

    res.json({ success: true, data: ticketDto(ticket, ticket.spot) });
  } catch (err) {
    next(err);
  }
}

// ─── GET /parking/tickets/history ────────────────────────────────────────────
export async function getTicketHistory(req: AuthReq | any, res: Response, next: NextFunction) {
  try {
    const tickets = await prisma.parkingTicket.findMany({
      where: { userId: req.userId, status: { not: 'ACTIVE' } },
      include: { spot: { include: { zone: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({ success: true, data: tickets.map((t) => ticketDto(t, t.spot)) });
  } catch (err) {
    next(err);
  }
}

// ─── POST /parking/tickets ────────────────────────────────────────────────────
// Body: { spotId, licensePlate, minutes?, lat?, lng?, accuracy? }
// El GPS del teléfono se valida contra la zona del cajón (si GPS_VALIDATION_ENABLED=true).
// Con `minutes` la sesión es prepagada con hora de vencimiento.
// Sin `minutes` se mantiene el flujo anterior (cobro al cerrar) por compatibilidad.
export async function createTicket(req: AuthReq | any, res: Response, next: NextFunction) {
  try {
    const { spotId, licensePlate, minutes: rawMinutes, lat, lng, accuracy } = req.body ?? {};
    const plate = typeof licensePlate === 'string' ? licensePlate.trim().toUpperCase().replace(/\s+/g, '') : '';

    if (!spotId || !plate) {
      return res.status(400).json({ success: false, message: 'spotId y licensePlate son requeridos' });
    }
    if (plate.length < 5 || plate.length > 10) {
      return res.status(400).json({ success: false, message: 'La placa debe tener entre 5 y 10 caracteres' });
    }

    let minutes: number | null = null;
    if (rawMinutes != null) {
      const check = validateMinutes(rawMinutes);
      if (!check.ok) return res.status(400).json({ success: false, message: check.message });
      minutes = check.minutes;
    }

    const spot = await prisma.parkingSpot.findUnique({ where: { id: String(spotId) }, include: { zone: true } });
    if (!spot) {
      return res.status(404).json({ success: false, message: 'Cajón no encontrado' });
    }

    // Verificación GPS (solo bloquea si GPS_VALIDATION_ENABLED=true)
    const gps = evaluateGps({ lat, lng, accuracy }, zoneTarget(spot.zone));
    if (!gps.ok) {
      return res.status(400).json({ success: false, message: gps.reason ?? 'Ubicación no válida' });
    }

    const activeTicket = await prisma.parkingTicket.findFirst({
      where: { userId: req.userId, status: 'ACTIVE' },
    });
    if (activeTicket) {
      return res.status(409).json({ success: false, message: 'Ya tienes un ticket activo' });
    }

    const now = new Date();
    const prepaid = minutes != null;
    const amount = prepaid ? costFor(minutes!, spot.zone.ratePerHour) : null;

    const ticket = await prisma.$transaction(async (tx) => {
      // Evita que dos personas tomen el mismo cajón al mismo tiempo
      const claimed = await tx.parkingSpot.updateMany({
        where: { id: spot.id, status: 'FREE' },
        data: { status: 'OCCUPIED' },
      });
      if (claimed.count === 0) {
        throw Object.assign(new Error('El cajón acaba de ser ocupado'), { status: 409 });
      }
      return tx.parkingTicket.create({
        data: {
          userId: req.userId,
          spotId: spot.id,
          licensePlate: plate,
          qrCode: crypto.randomUUID(),
          entryTime: now,
          plannedMinutes: minutes,
          scheduledEnd: prepaid ? new Date(now.getTime() + minutes! * 60000) : null,
          amountDue: amount,
          // Pago simulado hasta integrar Mercado Pago (Fase 5)
          amountPaid: amount,
          paymentMethod: prepaid ? 'CARD' : null,
          gpsLat: gps.lat,
          gpsLng: gps.lng,
          gpsAccuracy: gps.accuracyM,
          gpsDistanceM: gps.distanceM,
        },
      });
    });

    res.status(201).json({
      success: true,
      data: { ...ticketDto(ticket, spot), gpsWarning: gps.reason },
    });
  } catch (err: any) {
    if (err?.status === 409) {
      return res.status(409).json({ success: false, message: err.message });
    }
    next(err);
  }
}

// ─── POST /parking/tickets/:id/extend ────────────────────────────────────────
// Body: { minutes } — suma tiempo a una sesión prepagada (respeta el máximo total).
export async function extendTicket(req: AuthReq | any, res: Response, next: NextFunction) {
  try {
    const check = validateMinutes(req.body?.minutes);
    if (!check.ok) return res.status(400).json({ success: false, message: check.message });

    const ticket = await prisma.parkingTicket.findFirst({
      where: { id: String(req.params.id), userId: req.userId, status: 'ACTIVE' },
      include: { spot: { include: { zone: true } } },
    });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket no encontrado' });
    }
    if (!ticket.scheduledEnd || ticket.plannedMinutes == null) {
      return res.status(400).json({ success: false, message: 'Este ticket no tiene tiempo contratado' });
    }

    const total = ticket.plannedMinutes + check.minutes;
    if (total > parkingConfig.maxMinutes) {
      const left = parkingConfig.maxMinutes - ticket.plannedMinutes;
      return res.status(400).json({
        success: false,
        message: left > 0
          ? `Solo puedes extender ${left} minutos más (máximo ${parkingConfig.maxMinutes} por sesión).`
          : `Ya alcanzaste el máximo de ${parkingConfig.maxMinutes} minutos por sesión.`,
      });
    }

    const base = Math.max(ticket.scheduledEnd.getTime(), Date.now());
    const extra = costFor(check.minutes, ticket.spot.zone.ratePerHour);
    const updated = await prisma.parkingTicket.update({
      where: { id: ticket.id },
      data: {
        plannedMinutes: total,
        scheduledEnd: new Date(base + check.minutes * 60000),
        amountDue: Math.round(((ticket.amountDue ?? 0) + extra) * 100) / 100,
        amountPaid: Math.round(((ticket.amountPaid ?? 0) + extra) * 100) / 100, // pago simulado (Fase 5)
      },
    });

    res.json({ success: true, data: { ...ticketDto(updated, ticket.spot), charged: extra } });
  } catch (err) {
    next(err);
  }
}

// ─── POST /parking/tickets/:id/close ─────────────────────────────────────────
export async function closeTicket(req: AuthReq | any, res: Response, next: NextFunction) {
  try {
    const ticket = await prisma.parkingTicket.findFirst({
      where: { id: String(req.params.id), userId: req.userId, status: 'ACTIVE' },
      include: { spot: { include: { zone: true } } },
    });

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket no encontrado' });
    }

    const exitTime = new Date();
    const durationMs = exitTime.getTime() - ticket.entryTime.getTime();
    const durationMinutes = Math.ceil(durationMs / 60000);
    const rate = ticket.spot.zone.ratePerHour;

    // Sesión prepagada: se cobra lo contratado. Flujo anterior: se cobra el tiempo real.
    const prepaid = ticket.plannedMinutes != null;
    const amountDue = prepaid
      ? ticket.amountPaid ?? costFor(ticket.plannedMinutes!, rate)
      : Math.max(parseFloat(((durationMinutes / 60) * rate).toFixed(2)), rate / 4);

    await prisma.$transaction(async (tx) => {
      await tx.parkingTicket.update({
        where: { id: ticket.id },
        data: {
          status: 'COMPLETED',
          exitTime,
          durationMinutes,
          amountDue,
          amountPaid: amountDue,
          paymentMethod: ticket.paymentMethod ?? 'CARD',
        },
      });
      await tx.parkingSpot.update({
        where: { id: ticket.spotId },
        data: { status: 'FREE' },
      });
    });

    res.json({
      success: true,
      data: {
        ticketId: ticket.id,
        duration: `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`,
        ratePerHour: rate,
        totalAmount: amountDue,
        currency: 'MXN',
      },
    });
  } catch (err) {
    next(err);
  }
}
