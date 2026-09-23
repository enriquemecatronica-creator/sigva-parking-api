// backend/src/controllers/admin.controller.ts
// Admin endpoints for SIGVA dashboard — secured by X-Admin-Key header

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';

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

      let estado: string;
      switch (spot.status) {
        case 'FREE':
          estado = 'libre';
          break;
        case 'OCCUPIED':
          estado = 'ocupado_pagado';
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
        zona: spot.zone.name,
        estado,
        placa: activeTicket?.licensePlate ?? null,
        conductor: activeTicket?.user?.name ?? null,
        minutosEstacionado,
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

    res.json({
      success: true,
      data: {
        ticketId: ticket.id,
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
