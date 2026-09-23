// backend/src/lib/parking.ts
// Utilidades del flujo por GPS: configuración, distancia Haversine, zona cercana,
// QR de descarga por zona y cálculo de sesiones.

import { prisma } from './prisma';

// ─── Configuración (variables de entorno en Railway) ─────────────────────────
// GPS_VALIDATION_ENABLED=true  → rechaza sesiones fuera de la zona (activar cuando haya coordenadas reales)
// GPS_MAX_ACCURACY_M=20        → precisión mínima exigida al GPS del teléfono
// (el radio aceptado de cada zona está en parking_zones.radiusM, 100 m por defecto)
// APP_DOWNLOAD_ANDROID_URL / APP_DOWNLOAD_IOS_URL → tiendas a las que redirige el QR
// PARKING_MIN_MINUTES=15 / PARKING_MAX_MINUTES=120 / PARKING_STEP_MINUTES=15
// (se paga en bloques de 15 min: 15, 30, 45, 1 h ... hasta 2 h; tarifa por zona en parking_zones.ratePerHour)
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const parkingConfig = {
  get gpsEnforced() {
    return String(process.env.GPS_VALIDATION_ENABLED ?? '').toLowerCase() === 'true';
  },
  get maxAccuracyM() { return num('GPS_MAX_ACCURACY_M', 20); },
  get minMinutes() { return num('PARKING_MIN_MINUTES', 15); },
  get maxMinutes() { return num('PARKING_MAX_MINUTES', 120); },
  get stepMinutes() { return num('PARKING_STEP_MINUTES', 15); },
};

// ─── Distancia Haversine en metros ───────────────────────────────────────────
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface GpsInput { lat?: unknown; lng?: unknown; accuracy?: unknown }

export interface GpsResult {
  provided: boolean;
  ok: boolean;
  enforced: boolean;
  distanceM: number | null;
  accuracyM: number | null;
  reason: string | null;
  lat: number | null;
  lng: number | null;
}

// Evalúa la posición del teléfono contra el centro y radio de la zona.
// Si GPS_VALIDATION_ENABLED no está en true, nunca bloquea (solo informa la distancia).
export function evaluateGps(input: GpsInput, target: { lat: number; lng: number; radiusM: number }): GpsResult {
  const enforced = parkingConfig.gpsEnforced;
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  const acc = input.accuracy == null ? null : Number(input.accuracy);
  const provided = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);

  if (!provided) {
    return { provided, ok: !enforced, enforced, distanceM: null, accuracyM: acc, lat: null, lng: null,
      reason: 'No se recibió la ubicación del teléfono' };
  }

  const distanceM = Math.round(haversineM(lat, lng, target.lat, target.lng) * 10) / 10;
  let reason: string | null = null;
  if (acc != null && Number.isFinite(acc) && acc > parkingConfig.maxAccuracyM) {
    reason = `GPS impreciso (±${Math.round(acc)} m). Espera unos segundos a cielo abierto e inténtalo de nuevo.`;
  } else if (distanceM > target.radiusM) {
    reason = `Estás a ${Math.round(distanceM)} m de la zona (máximo ${target.radiusM} m). Acércate a la zona para iniciar.`;
  }
  return { provided, ok: reason == null || !enforced, enforced, distanceM, accuracyM: acc, lat, lng, reason };
}

// ─── QR de descarga por zona ─────────────────────────────────────────────────
// Cada zona tiene 1 QR (máximo 2) cuyo único fin es descargar la app.
// El QR contiene {PUBLIC_API_URL}/descargar?zona=MTY01A (la URL nunca cambia aunque
// cambien los enlaces de las tiendas).
export const MAX_QR_PER_ZONE = 2;

export function downloadUrlFor(code: string, baseUrl?: string): string {
  const base = (process.env.PUBLIC_API_URL || baseUrl || '').replace(/\/$/, '');
  return `${base}/descargar?zona=${encodeURIComponent(code)}`;
}

// Acepta "MTY01A", "mty01a" o una URL con ?zona=MTY01A.
export function normalizeQrCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const m = s.match(/[?&]zona=([^&#]+)/i);
  if (m) s = decodeURIComponent(m[1]);
  s = s.toUpperCase();
  return /^[A-Z0-9]{3,12}$/.test(s) ? s : null;
}

// Código base de la zona según su orden de creación: MTY01, MTY02, ...
// Las letras A/B distinguen el primer y segundo QR de la misma zona.
function zoneBase(index: number): string {
  return `MTY${String(index + 1).padStart(2, '0')}`;
}

// Crea el QR "A" de cada zona que todavía no tiene ninguno. No modifica QR existentes
// (los stickers impresos siguen siendo válidos).
export async function ensureZoneQrCodes(): Promise<number> {
  const zones = await prisma.parkingZone.findMany({
    orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
    include: { qrCodes: true },
  });
  const used = new Set(
    (await prisma.zoneQr.findMany({ select: { code: true } })).map((q) => q.code.replace(/[A-Z]$/, ''))
  );
  let next = 0;
  let created = 0;
  for (const zone of zones) {
    if (zone.qrCodes.length > 0) continue;
    let base = zoneBase(next++);
    while (used.has(base)) base = zoneBase(next++);
    await prisma.zoneQr.create({ data: { code: `${base}A`, zoneId: zone.id, label: 'QR principal' } });
    used.add(base);
    created++;
  }
  return created;
}

// Agrega el segundo QR (letra B) a una zona. Devuelve null si ya tiene el máximo.
export async function addSecondZoneQr(zoneId: string, label?: string) {
  const qrs = await prisma.zoneQr.findMany({ where: { zoneId }, orderBy: { code: 'asc' } });
  if (qrs.length >= MAX_QR_PER_ZONE) return null;
  if (qrs.length === 0) {
    await ensureZoneQrCodes();
    return prisma.zoneQr.findFirst({ where: { zoneId } });
  }
  const base = qrs[0].code.replace(/[A-Z]$/, '');
  return prisma.zoneQr.create({
    data: { code: `${base}B`, zoneId, label: label?.trim() || 'QR secundario' },
  });
}

// ─── Zona más cercana ────────────────────────────────────────────────────────
export interface ZoneLike { id: string; latitude: number; longitude: number; radiusM: number }

export function zonesByDistance<T extends ZoneLike>(zones: T[], lat: number, lng: number) {
  return zones
    .map((z) => {
      const distanceM = Math.round(haversineM(lat, lng, z.latitude, z.longitude));
      return { zone: z, distanceM, inside: distanceM <= z.radiusM };
    })
    .sort((a, b) => a.distanceM - b.distanceM);
}

// ─── Sesiones ────────────────────────────────────────────────────────────────
export function validateMinutes(raw: unknown): { ok: true; minutes: number } | { ok: false; message: string } {
  const m = Number(raw);
  const { minMinutes, maxMinutes, stepMinutes } = parkingConfig;
  if (!Number.isInteger(m) || m < minMinutes || m > maxMinutes || m % stepMinutes !== 0) {
    return { ok: false, message: `El tiempo debe ser de ${minMinutes} a ${maxMinutes} minutos, en bloques de ${stepMinutes}.` };
  }
  return { ok: true, minutes: m };
}

export function costFor(minutes: number, ratePerHour: number): number {
  return Math.round(((minutes / 60) * ratePerHour) * 100) / 100;
}

export function remainingMinutes(scheduledEnd: Date | null | undefined, now = Date.now()): number | null {
  if (!scheduledEnd) return null;
  return Math.ceil((scheduledEnd.getTime() - now) / 60000);
}
