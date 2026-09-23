// backend/src/lib/reports.ts
// Cálculos de reportes del parquímetro (recaudación por día, ocupación por hora, por zona).
// Todas las fechas y horas se agrupan en hora de México (America/Mexico_City, UTC-6),
// no en la hora del servidor (UTC).

export const REPORT_TZ = process.env.REPORT_TZ || 'America/Mexico_City';

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const HOUR_FMT = new Intl.DateTimeFormat('en-US', { timeZone: REPORT_TZ, hour: '2-digit', hourCycle: 'h23' });
const PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

// "2026-09-23" en hora de México
export function dayKey(d: Date): string {
  return DAY_FMT.format(d);
}

// 0..23 en hora de México
export function hourOf(d: Date): number {
  return Number(HOUR_FMT.format(d)) % 24;
}

// Diferencia en minutos entre UTC y la hora de México para esa fecha (México: -360)
function tzOffsetMin(d: Date): number {
  const parts = PARTS_FMT.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - d.getTime()) / 60000);
}

// Medianoche de hoy (hora de México) como instante UTC
export function startOfDayLocal(now: Date = new Date()): Date {
  const [y, m, d] = dayKey(now).split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - tzOffsetMin(guess) * 60000);
}

export interface ReportTicket {
  entryTime: Date;
  exitTime: Date | null;
  scheduledEnd: Date | null;
  status: string;
  amountPaid: number | null;
  autoReleased?: boolean | null;
  zoneId: string;
}
export interface ReportZone { id: string; name: string; spots: number }
export interface ReportInfraction { createdAt: Date; amount: number | null; status: string }

const round2 = (n: number) => Math.round(n * 100) / 100;

// Construye el reporte de los últimos `days` días (incluye hoy).
export function buildReport(
  tickets: ReportTicket[],
  zones: ReportZone[],
  infractions: ReportInfraction[],
  days: number,
  now: Date = new Date(),
) {
  const todayStart = startOfDayLocal(now);
  const from = new Date(todayStart.getTime() - (days - 1) * 86400000);

  // Días del periodo (en orden)
  const dayKeys: string[] = [];
  for (let i = 0; i < days; i++) dayKeys.push(dayKey(new Date(from.getTime() + i * 86400000 + 12 * 3600000)));
  const porDia = new Map(dayKeys.map((k) => [k, { fecha: k, recaudacion: 0, sesiones: 0, infracciones: 0 }]));

  // Minutos ocupados por hora del día (0..23), sumando todos los días del periodo
  const minutosPorHora = new Array(24).fill(0);
  const zonaStats = new Map(zones.map((z) => [z.id, { zona: z.name, cajones: z.spots, sesiones: 0, recaudacion: 0, minutos: 0 }]));

  let autoLiberadas = 0;
  let duracionTotal = 0;

  for (const t of tickets) {
    const k = dayKey(t.entryTime);
    const d = porDia.get(k);
    if (d) {
      d.sesiones++;
      d.recaudacion += t.amountPaid ?? 0;
    }
    const z = zonaStats.get(t.zoneId);
    // Sesiones, dinero y duración cuentan solo si la sesión empezó dentro del periodo
    if (d) {
      if (z) { z.sesiones++; z.recaudacion += t.amountPaid ?? 0; }
      if (t.autoReleased) autoLiberadas++;
      const fin = t.exitTime ?? (t.status === 'ACTIVE' ? now : t.scheduledEnd ?? now);
      duracionTotal += Math.max(0, (Math.min(fin.getTime(), now.getTime()) - t.entryTime.getTime()) / 60000);
    }

    // Intervalo ocupado: entrada → salida real (o vencimiento/ahora si sigue activo)
    const start = Math.max(t.entryTime.getTime(), from.getTime());
    const endRaw = t.exitTime ?? (t.status === 'ACTIVE' ? now : t.scheduledEnd ?? now);
    const end = Math.min(endRaw.getTime(), now.getTime());
    if (end <= start) continue;
    const mins = (end - start) / 60000;
    if (z) z.minutos += mins;
    // Reparte los minutos en cada hora del reloj (hora de México)
    const off = tzOffsetMin(new Date(start)) * 60000;
    for (let ms = start; ms < end; ) {
      const hourIdx = Math.floor((ms + off) / 3600000);
      const next = Math.min(end, (hourIdx + 1) * 3600000 - off);
      minutosPorHora[((hourIdx % 24) + 24) % 24] += (next - ms) / 60000;
      ms = next;
    }
  }

  for (const i of infractions) {
    const d = porDia.get(dayKey(i.createdAt));
    if (d) d.infracciones++;
  }

  const totalCajones = zones.reduce((s, z) => s + z.spots, 0);
  const ocupacionPorHora = minutosPorHora.map((m, h) => ({
    hora: h,
    // Cajones ocupados en promedio en esa hora (minutos ocupados / (60 min × días))
    cajonesPromedio: round2(m / (60 * days)),
    porcentaje: totalCajones ? round2((m / (60 * days * totalCajones)) * 100) : 0,
  }));

  const dias = [...porDia.values()].map((d) => ({ ...d, recaudacion: round2(d.recaudacion) }));
  const recaudacionTotal = round2(dias.reduce((s, d) => s + d.recaudacion, 0));
  const sesionesTotal = dias.reduce((s, d) => s + d.sesiones, 0);

  return {
    desde: dayKeys[0],
    hasta: dayKeys[dayKeys.length - 1],
    dias: days,
    zonaHoraria: REPORT_TZ,
    resumen: {
      recaudacion: recaudacionTotal,
      sesiones: sesionesTotal,
      ticketPromedio: sesionesTotal ? round2(recaudacionTotal / sesionesTotal) : 0,
      duracionPromedioMin: sesionesTotal ? Math.round(duracionTotal / sesionesTotal) : 0,
      liberadasAutomaticamente: autoLiberadas,
      infracciones: infractions.length,
      totalCajones,
    },
    porDia: dias,
    ocupacionPorHora,
    porZona: [...zonaStats.values()]
      .map((z) => ({
        zona: z.zona,
        cajones: z.cajones,
        sesiones: z.sesiones,
        recaudacion: round2(z.recaudacion),
        // % del tiempo que sus cajones estuvieron ocupados (24 h × días)
        ocupacionPct: z.cajones ? round2((z.minutos / (z.cajones * 1440 * days)) * 100) : 0,
      }))
      .sort((a, b) => b.recaudacion - a.recaudacion),
  };
}
