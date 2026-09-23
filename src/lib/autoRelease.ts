// backend/src/lib/autoRelease.ts
// Libera solos los cajones cuyo tiempo pagado venció hace más de AUTO_RELEASE_MINUTES
// y el conductor nunca tocó "Ya me voy". Así el mapa no muestra cajones ocupados que ya están vacíos.
//
// Variables en Railway (opcionales):
//   AUTO_RELEASE_MINUTES=30  → minutos de tolerancia después del vencimiento (0 = apagado)
//   AUTO_RELEASE_INTERVAL_S=60 → cada cuántos segundos se revisa
//
// Durante esa tolerancia el cajón sigue en rojo ("sin pago") en el dashboard para que el
// inspector pueda revisar y levantar la infracción.

import { prisma } from './prisma';

export const autoReleaseConfig = {
  get minutes(): number {
    const raw = process.env.AUTO_RELEASE_MINUTES;
    if (raw == null || raw.trim() === '') return 30;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 30;
  },
  get intervalMs(): number {
    const v = Number(process.env.AUTO_RELEASE_INTERVAL_S);
    return (Number.isFinite(v) && v >= 15 ? v : 60) * 1000;
  },
};

// Minutos que faltan para que el sistema libere un cajón vencido (null si no aplica).
export function minutesUntilRelease(remaining: number | null): number | null {
  const tol = autoReleaseConfig.minutes;
  if (remaining == null || remaining > 0 || tol <= 0) return null;
  return Math.max(0, remaining + tol);
}

export interface ReleaseResult {
  released: number;
  ticketIds: string[];
}

export async function releaseExpiredTickets(now: Date = new Date()): Promise<ReleaseResult> {
  const tol = autoReleaseConfig.minutes;
  if (tol <= 0) return { released: 0, ticketIds: [] };

  const cutoff = new Date(now.getTime() - tol * 60000);
  const due = await prisma.parkingTicket.findMany({
    where: { status: 'ACTIVE', scheduledEnd: { lt: cutoff } },
    select: { id: true, spotId: true, entryTime: true, amountPaid: true },
    orderBy: { scheduledEnd: 'asc' },
    take: 200,
  });

  const ticketIds: string[] = [];
  for (const t of due) {
    const ok = await prisma.$transaction(async (tx) => {
      // Solo si sigue activo (el conductor pudo cerrarlo en ese mismo instante)
      const closed = await tx.parkingTicket.updateMany({
        where: { id: t.id, status: 'ACTIVE' },
        data: {
          status: 'COMPLETED',
          exitTime: now,
          durationMinutes: Math.max(0, Math.ceil((now.getTime() - t.entryTime.getTime()) / 60000)),
          amountDue: t.amountPaid ?? null, // prepagado: se cobra solo lo pagado
          autoReleased: true,
        },
      });
      if (closed.count === 0) return false;
      const stillActive = await tx.parkingTicket.count({ where: { spotId: t.spotId, status: 'ACTIVE' } });
      if (stillActive === 0) {
        await tx.parkingSpot.updateMany({ where: { id: t.spotId, status: 'OCCUPIED' }, data: { status: 'FREE' } });
      }
      return true;
    });
    if (ok) ticketIds.push(t.id);
  }
  return { released: ticketIds.length, ticketIds };
}

// Arranca la revisión periódica. Devuelve una función para detenerla.
export function startAutoRelease(log: (msg: string) => void = console.log): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await releaseExpiredTickets();
      if (r.released > 0) log(`🅿️  Liberados automáticamente ${r.released} cajón(es) con tiempo vencido`);
    } catch (e) {
      console.error('Liberación automática falló:', e);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, autoReleaseConfig.intervalMs);
  timer.unref?.();
  setTimeout(tick, 5000).unref?.();
  return () => clearInterval(timer);
}
