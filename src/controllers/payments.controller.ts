// backend/src/controllers/payments.controller.ts
// Flujo de cobro con Mercado Pago:
//  1. La app pide iniciar (o extender) → se aparta el cajón y se crea la liga de pago.
//  2. El conductor paga en Mercado Pago.
//  3. Mercado Pago avisa a /api/v1/pagos/webhook → se consulta el pago directo a su API
//     (nunca se confía en lo que dice la notificación) y se activa la sesión.
//  4. Si no paga a tiempo, el cajón se libera solo (expirePendingPayments).
// Si el pago llega cuando la sesión ya no se puede activar, se reembolsa automáticamente.

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { parkingConfig } from '../lib/parking';
import {
  createCheckout,
  fetchPayment,
  methodFrom,
  paymentsConfig,
  refundPayment,
  verifyWebhookSignature,
} from '../lib/payments';

export function paymentDto(p: any) {
  if (!p) return null;
  return {
    id: p.id,
    tipo: String(p.kind).toLowerCase(),
    minutos: p.minutes,
    monto: p.amount,
    moneda: p.currency,
    estado: String(p.status).toLowerCase(),
    checkoutUrl: p.status === 'PENDIENTE' ? p.checkoutUrl : null,
    proveedor: p.provider,
  };
}

// ─── Inicio de sesión con pago real ───────────────────────────────────────────
// Aparta el cajón (RESERVED), crea el ticket PENDING_PAYMENT y la liga de pago.
export async function startPaidSession(args: {
  userId: string;
  userEmail?: string | null;
  spot: { id: string; number: string; zoneId: string; zone: { name: string } };
  plate: string;
  minutes: number;
  amount: number;
  gps: { lat: number | null; lng: number | null; accuracyM: number | null; distanceM: number | null };
  qrCode: string;
}) {
  const { ticket, payment } = await prisma.$transaction(async (tx) => {
    const claimed = await tx.parkingSpot.updateMany({ where: { id: args.spot.id, status: 'FREE' }, data: { status: 'RESERVED' } });
    if (claimed.count === 0) throw Object.assign(new Error('El cajón acaba de ser ocupado'), { status: 409 });
    const ticket = await tx.parkingTicket.create({
      data: {
        userId: args.userId,
        spotId: args.spot.id,
        licensePlate: args.plate,
        qrCode: args.qrCode,
        status: 'PENDING_PAYMENT',
        plannedMinutes: args.minutes,
        amountDue: args.amount,
        gpsLat: args.gps.lat,
        gpsLng: args.gps.lng,
        gpsAccuracy: args.gps.accuracyM,
        gpsDistanceM: args.gps.distanceM,
      },
    });
    const payment = await tx.payment.create({
      data: { ticketId: ticket.id, kind: 'INICIO', minutes: args.minutes, amount: args.amount, provider: 'mercadopago' },
    });
    return { ticket, payment };
  });

  try {
    const co = await createCheckout({
      paymentId: payment.id,
      title: `Estacionamiento ${args.spot.zone.name} · cajón ${args.spot.number} · ${args.minutes} min`,
      amount: args.amount,
      payerEmail: args.userEmail,
    });
    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { preferenceId: co.preferenceId, checkoutUrl: co.checkoutUrl },
    });
    return { ticket, payment: updated };
  } catch (e) {
    // No se pudo crear la liga: se deshace todo
    await cancelPendingTicket(ticket.id, 'EXPIRADO');
    throw Object.assign(new Error('No se pudo iniciar el pago con Mercado Pago. Intenta de nuevo.'), { status: 502, cause: e });
  }
}

// ─── Extensión con pago real ──────────────────────────────────────────────────
export async function startPaidExtension(args: { ticket: any; minutes: number; amount: number; userEmail?: string | null }) {
  const payment = await prisma.payment.create({
    data: { ticketId: args.ticket.id, kind: 'EXTENSION', minutes: args.minutes, amount: args.amount, provider: 'mercadopago' },
  });
  try {
    const co = await createCheckout({
      paymentId: payment.id,
      title: `Tiempo extra ${args.minutes} min · ${args.ticket.spot.zone.name} · cajón ${args.ticket.spot.number}`,
      amount: args.amount,
      payerEmail: args.userEmail,
    });
    return prisma.payment.update({ where: { id: payment.id }, data: { preferenceId: co.preferenceId, checkoutUrl: co.checkoutUrl } });
  } catch (e) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'EXPIRADO' } });
    throw Object.assign(new Error('No se pudo iniciar el pago con Mercado Pago. Intenta de nuevo.'), { status: 502, cause: e });
  }
}

// Cancela un ticket pendiente de pago y libera su cajón.
export async function cancelPendingTicket(ticketId: string, paymentStatus: 'EXPIRADO' | 'RECHAZADO' = 'EXPIRADO') {
  return prisma.$transaction(async (tx) => {
    const t = await tx.parkingTicket.findFirst({ where: { id: ticketId, status: 'PENDING_PAYMENT' } });
    if (!t) return false;
    const done = await tx.parkingTicket.updateMany({
      where: { id: ticketId, status: 'PENDING_PAYMENT' },
      data: { status: 'CANCELLED', exitTime: new Date() },
    });
    if (done.count === 0) return false;
    await tx.parkingSpot.updateMany({ where: { id: t.spotId, status: 'RESERVED' }, data: { status: 'FREE' } });
    await tx.payment.updateMany({ where: { ticketId, status: 'PENDIENTE' }, data: { status: paymentStatus } });
    return true;
  });
}

// Libera los cajones de pagos no completados a tiempo (lo llama la revisión periódica).
export async function expirePendingPayments(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - paymentsConfig.pendingMinutes * 60000);
  const stale = await prisma.parkingTicket.findMany({
    where: { status: 'PENDING_PAYMENT', createdAt: { lt: cutoff } },
    select: { id: true },
    take: 200,
  });
  let n = 0;
  for (const t of stale) if (await cancelPendingTicket(t.id, 'EXPIRADO')) n++;
  // Extensiones sin pagar: solo se marcan como vencidas
  await prisma.payment.updateMany({
    where: { kind: 'EXTENSION', status: 'PENDIENTE', createdAt: { lt: cutoff } },
    data: { status: 'EXPIRADO' },
  });
  return n;
}

async function refundAndMark(paymentId: string, providerPaymentId: string, reason: string) {
  try {
    await refundPayment(providerPaymentId);
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'REEMBOLSADO', providerPaymentId } });
    console.warn(`Pago ${providerPaymentId} reembolsado: ${reason}`);
  } catch (e) {
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'REEMBOLSO_PENDIENTE', providerPaymentId } });
    console.error(`No se pudo reembolsar el pago ${providerPaymentId} (${reason}). Revisar en Mercado Pago.`, e);
  }
}

// Aplica un pago de Mercado Pago (idempotente: se puede llamar varias veces con el mismo pago).
export async function processProviderPayment(providerPaymentId: string): Promise<string> {
  const p = await fetchPayment(providerPaymentId);
  if (!p.externalReference) return 'sin_referencia';
  const payment = await prisma.payment.findUnique({
    where: { id: p.externalReference },
    include: { ticket: true },
  });
  if (!payment) return 'desconocido';
  if (['APROBADO', 'REEMBOLSADO', 'REEMBOLSO_PENDIENTE'].includes(payment.status)) return 'ya_procesado';

  if (p.status === 'approved') {
    if (p.amount + 0.01 < payment.amount) {
      await refundAndMark(payment.id, p.id, `monto ${p.amount} menor a ${payment.amount}`);
      return 'monto_incorrecto';
    }
    const now = new Date();
    const method = methodFrom(p.paymentType);

    if (payment.kind === 'INICIO') {
      const ok = await prisma.$transaction(async (tx) => {
        const act = await tx.parkingTicket.updateMany({
          where: { id: payment.ticketId, status: 'PENDING_PAYMENT' },
          data: {
            status: 'ACTIVE',
            entryTime: now,
            scheduledEnd: new Date(now.getTime() + payment.minutes * 60000),
            amountPaid: payment.amount,
            paymentMethod: method,
          },
        });
        if (act.count === 0) return false;
        await tx.parkingSpot.updateMany({ where: { id: payment.ticket.spotId, status: 'RESERVED' }, data: { status: 'OCCUPIED' } });
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: 'APROBADO', approvedAt: now, providerPaymentId: p.id, providerStatus: p.status },
        });
        return true;
      });
      if (!ok) {
        await refundAndMark(payment.id, p.id, 'la sesión ya no estaba pendiente (tiempo de pago vencido o cancelada)');
        return 'reembolsado';
      }
      return 'activado';
    }

    // EXTENSION
    const ok = await prisma.$transaction(async (tx) => {
      const t = await tx.parkingTicket.findFirst({ where: { id: payment.ticketId, status: 'ACTIVE' } });
      if (!t || t.plannedMinutes == null || t.plannedMinutes + payment.minutes > parkingConfig.maxMinutes) return false;
      const base = Math.max(t.scheduledEnd ? t.scheduledEnd.getTime() : now.getTime(), now.getTime());
      await tx.parkingTicket.update({
        where: { id: t.id },
        data: {
          plannedMinutes: t.plannedMinutes + payment.minutes,
          scheduledEnd: new Date(base + payment.minutes * 60000),
          amountDue: Math.round(((t.amountDue ?? 0) + payment.amount) * 100) / 100,
          amountPaid: Math.round(((t.amountPaid ?? 0) + payment.amount) * 100) / 100,
        },
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'APROBADO', approvedAt: now, providerPaymentId: p.id, providerStatus: p.status },
      });
      return true;
    });
    if (!ok) {
      await refundAndMark(payment.id, p.id, 'la extensión ya no se podía aplicar');
      return 'reembolsado';
    }
    return 'extendido';
  }

  if (p.status === 'rejected' || p.status === 'cancelled') {
    await prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDIENTE' }, data: { providerStatus: p.status } });
    if (payment.kind === 'INICIO') await cancelPendingTicket(payment.ticketId, 'RECHAZADO');
    else await prisma.payment.updateMany({ where: { id: payment.id, status: 'PENDIENTE' }, data: { status: 'RECHAZADO' } });
    return 'rechazado';
  }

  await prisma.payment.update({ where: { id: payment.id }, data: { providerStatus: p.status } });
  return 'en_proceso';
}

// ─── POST /api/v1/pagos/webhook (Mercado Pago) ────────────────────────────────
export async function mercadoPagoWebhook(req: Request, res: Response) {
  const type = String(req.body?.type ?? req.query.type ?? req.query.topic ?? '');
  const dataId = String(req.body?.data?.id ?? req.query['data.id'] ?? req.query.id ?? '');
  if (type !== 'payment' || !dataId) return res.status(200).json({ ok: true, ignorado: true });
  if (paymentsConfig.provider !== 'mercadopago') return res.status(200).json({ ok: true, ignorado: true });
  if (!verifyWebhookSignature(req.headers as any, dataId)) return res.status(401).json({ ok: false });
  try {
    const resultado = await processProviderPayment(dataId);
    res.status(200).json({ ok: true, resultado });
  } catch (e) {
    console.error('Webhook de Mercado Pago falló:', e);
    res.status(500).json({ ok: false }); // Mercado Pago reintenta más tarde
  }
}

// ─── GET /api/v1/parking/pagos/:id ────────────────────────────────────────────
// La app lo consulta al volver de Mercado Pago para saber si ya se confirmó el pago.
export async function getPaymentStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const payment = await prisma.payment.findUnique({ where: { id: String(req.params.id) }, include: { ticket: true } });
    if (!payment || payment.ticket.userId !== (req as any).userId) {
      return res.status(404).json({ success: false, message: 'Pago no encontrado' });
    }
    res.json({ success: true, data: { ...paymentDto(payment), ticketId: payment.ticketId, ticketEstado: String(payment.ticket.status).toLowerCase() } });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/v1/parking/tickets/:id/cancelar ────────────────────────────────
// El conductor abandona un pago pendiente: se libera el cajón.
export async function cancelPendingByUser(req: Request, res: Response, next: NextFunction) {
  try {
    const t = await prisma.parkingTicket.findFirst({
      where: { id: String(req.params.id), userId: (req as any).userId, status: 'PENDING_PAYMENT' },
    });
    if (!t) return res.status(404).json({ success: false, message: 'No hay un pago pendiente para cancelar' });
    await cancelPendingTicket(t.id, 'EXPIRADO');
    res.json({ success: true, message: 'Se canceló el pago pendiente y se liberó el cajón' });
  } catch (err) {
    next(err);
  }
}

// ─── GET /pagos/retorno ───────────────────────────────────────────────────────
// Página a la que regresa Mercado Pago después de pagar.
export function paymentReturnPage(req: Request, res: Response) {
  const status = String(req.query.status ?? req.query.collection_status ?? '');
  const ok = status === 'approved';
  const msg = ok
    ? 'Pago recibido. Regresa a la app SIGVA Parquímetro: tu tiempo ya está corriendo.'
    : status === 'pending' || status === 'in_process'
      ? 'Tu pago está en proceso. Regresa a la app; te avisaremos cuando se confirme.'
      : 'El pago no se completó. Regresa a la app para intentarlo de nuevo.';
  res
    .status(200)
    .type('html')
    .send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SIGVA Parquímetro</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#F7F8FC;color:#0F1A35;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
.c{background:#fff;border-radius:16px;padding:28px;max-width:360px;text-align:center;box-shadow:0 4px 20px rgba(15,26,53,.08)}h1{font-size:20px;margin:0 0 10px}p{color:#4A5578;line-height:1.5}</style></head>
<body><div class="c"><h1>${ok ? '✅ ¡Listo!' : 'SIGVA Parquímetro'}</h1><p>${msg}</p></div></body></html>`);
}
