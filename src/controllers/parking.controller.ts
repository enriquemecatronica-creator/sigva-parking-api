// backend/src/controllers/parking.controller.ts

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import crypto from 'crypto';

type AuthReq = Request & { userId: string };

// ─── GET /parking/zones ───────────────────────────────────────────────────────
export async function getZones(req: Request, res: Response, next: NextFunction) {
  try {
    const zones = await prisma.parkingZone.findMany({
      where: { isActive: true },
      include: {
        _count: { select: { spots: { where: { status: 'FREE' } } } },
      },
      orderBy: { name: 'asc' },
    });

    const result = zones.map((z) => ({
      id: z.id,
      name: z.name,
      address: z.address,
      latitude: z.latitude,
      longitude: z.longitude,
      totalSpots: z.totalSpots,
      freeSpots: z._count.spots,
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
      where: { id: req.params.id },
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
        totalSpots: zone.totalSpots,
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

    res.json({
      success: true,
      data: {
        id: ticket.id,
        userId: ticket.userId,
        spotId: ticket.spotId,
        zoneId: ticket.spot.zoneId,
        zoneName: ticket.spot.zone.name,
        spotNumber: ticket.spot.number,
        status: ticket.status.toLowerCase(),
        entryTime: ticket.entryTime,
        exitTime: ticket.exitTime,
        licensePlate: ticket.licensePlate,
        qrCode: ticket.qrCode,
      },
    });
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

    const result = tickets.map((t) => ({
      id: t.id,
      userId: t.userId,
      spotId: t.spotId,
      zoneId: t.spot.zoneId,
      zoneName: t.spot.zone.name,
      spotNumber: t.spot.number,
      status: t.status.toLowerCase(),
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      durationMinutes: t.durationMinutes,
      amountDue: t.amountDue,
      amountPaid: t.amountPaid,
      paymentMethod: t.paymentMethod?.toLowerCase(),
      licensePlate: t.licensePlate,
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// ─── POST /parking/tickets ────────────────────────────────────────────────────
export async function createTicket(req: AuthReq | any, res: Response, next: NextFunction) {
  try {
    const { spotId, licensePlate } = req.body;
    if (!spotId || !licensePlate) {
      return res.status(400).json({ success: false, message: 'spotId y licensePlate requeridos' });
    }

    // Verificar que el cajón existe y está libre
    const spot = await prisma.parkingSpot.findUnique({
      where: { id: spotId },
      include: { zone: true },
    });

    if (!spot) {
      return res.status(404).json({ success: false, message: 'Cajón no encontrado' });
    }
    if (spot.status !== 'FREE') {
      return res.status(409).json({ success: false, message: 'El cajón no está disponible' });
    }

    // Verificar que el usuario no tiene un ticket activo
    const activeTicket = await prisma.parkingTicket.findFirst({
      where: { userId: req.userId, status: 'ACTIVE' },
    });
    if (activeTicket) {
      return res.status(409).json({ success: false, message: 'Ya tienes un ticket activo' });
    }

    const qrCode = crypto.randomUUID();

    // Crear ticket y marcar cajón como ocupado (transacción)
    const ticket = await prisma.$transaction(async (tx) => {
      const t = await tx.parkingTicket.create({
        data: {
          userId: req.userId,
          spotId,
          licensePlate: licensePlate.toUpperCase(),
          qrCode,
        },
      });
      await tx.parkingSpot.update({
        where: { id: spotId },
        data: { status: 'OCCUPIED' },
      });
      return t;
    });

    res.status(201).json({
      success: true,
      data: {
        id: ticket.id,
        userId: ticket.userId,
        spotId: ticket.spotId,
        zoneId: spot.zoneId,
        zoneName: spot.zone.name,
        spotNumber: spot.number,
        status: 'active',
        entryTime: ticket.entryTime,
        licensePlate: ticket.licensePlate,
        qrCode: ticket.qrCode,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /parking/tickets/:id/close ─────────────────────────────────────────
export async function closeTicket(req: AuthReq | any, res: Response, next: NextFunction) {
  try {
    const ticket = await prisma.parkingTicket.findFirst({
      where: { id: req.params.id, userId: req.userId, status: 'ACTIVE' },
      include: { spot: { include: { zone: true } } },
    });

    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket no encontrado' });
    }

    const exitTime = new Date();
    const durationMs = exitTime.getTime() - ticket.entryTime.getTime();
    const durationMinutes = Math.ceil(durationMs / 60000);
    const hours = durationMinutes / 60;
    const amountDue = Math.max(parseFloat((hours * ticket.spot.zone.ratePerHour).toFixed(2)), ticket.spot.zone.ratePerHour / 4);

    await prisma.$transaction(async (tx) => {
      await tx.parkingTicket.update({
        where: { id: ticket.id },
        data: {
          status: 'COMPLETED',
          exitTime,
          durationMinutes,
          amountDue,
          amountPaid: amountDue,
          paymentMethod: 'CARD',
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
        ratePerHour: ticket.spot.zone.ratePerHour,
        totalAmount: amountDue,
        currency: 'MXN',
      },
    });
  } catch (err) {
    next(err);
  }
}
