// tests/helpers/fakePrisma.ts
// Base de datos en memoria que imita lo que usan los controladores (sin Postgres).
// Se inyecta en lugar de src/lib/prisma antes de cargar los controladores.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

let seq = 0;
const newId = (p: string) => `${p}_${++seq}`;

function matchValue(v: any, cond: any): boolean {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
    if ('not' in cond) return !matchValue(v, cond.not);
    if ('lt' in cond && !(v != null && v < cond.lt)) return false;
    if ('lte' in cond && !(v != null && v <= cond.lte)) return false;
    if ('gt' in cond && !(v != null && v > cond.gt)) return false;
    if ('gte' in cond && !(v != null && v >= cond.gte)) return false;
    if ('in' in cond && !cond.in.includes(v)) return false;
    return true;
  }
  if (v instanceof Date && cond instanceof Date) return v.getTime() === cond.getTime();
  return v === cond;
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => matchValue(row[k], cond));
}

export function createFakeDb() {
  const db = {
    zones: [] as Row[],
    spots: [] as Row[],
    tickets: [] as Row[],
    infractions: [] as Row[],
    users: [] as Row[],
  };
  let infractionNumber = 0;

  const zoneOf = (spot: Row) => db.zones.find((z) => z.id === spot.zoneId);
  const withSpot = (t: Row, include: any) => {
    if (!include?.spot) return { ...t };
    const spot = db.spots.find((s) => s.id === t.spotId)!;
    return { ...t, spot: { ...spot, zone: zoneOf(spot) } };
  };
  const touch = (row: Row) => { row.updatedAt = new Date(); return row; };
  const maxUpdated = (rows: Row[]) =>
    rows.reduce<Date | null>((m, r) => (!m || r.updatedAt > m ? r.updatedAt : m), null);

  const prisma: any = {
    parkingZone: {
      findMany: async () => db.zones.map((z) => ({ ...z })),
    },
    parkingSpot: {
      findUnique: async ({ where, include, select }: any) => {
        const s = db.spots.find((x) => x.id === where.id);
        if (!s) return null;
        if (select) return Object.fromEntries(Object.keys(select).map((k) => [k, s[k]]));
        return include?.zone ? { ...s, zone: zoneOf(s) } : { ...s };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = db.spots.filter((s) => matches(s, where));
        rows.forEach((s) => touch(Object.assign(s, data)));
        return { count: rows.length };
      },
      update: async ({ where, data }: any) => {
        const s = db.spots.find((x) => x.id === where.id)!;
        return { ...touch(Object.assign(s, data)) };
      },
      aggregate: async () => ({ _max: { updatedAt: maxUpdated(db.spots) } }),
    },
    parkingTicket: {
      findFirst: async ({ where, include }: any) => {
        const t = db.tickets.find((x) => matches(x, where));
        return t ? withSpot(t, include) : null;
      },
      findMany: async ({ where, select }: any) => {
        const rows = db.tickets.filter((x) => matches(x, where));
        return rows.map((t) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, t[k]])) : { ...t }));
      },
      count: async ({ where }: any) => db.tickets.filter((x) => matches(x, where)).length,
      create: async ({ data }: any) => {
        const t = touch({
          id: newId('tk'), status: 'ACTIVE', entryTime: new Date(), exitTime: null, durationMinutes: null,
          autoReleased: false, createdAt: new Date(), ...data,
        });
        db.tickets.push(t);
        return { ...t };
      },
      update: async ({ where, data }: any) => {
        const t = db.tickets.find((x) => x.id === where.id)!;
        return { ...touch(Object.assign(t, data)) };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = db.tickets.filter((x) => matches(x, where));
        rows.forEach((t) => touch(Object.assign(t, data)));
        return { count: rows.length };
      },
      aggregate: async () => ({ _max: { updatedAt: maxUpdated(db.tickets) } }),
    },
    infraction: {
      findFirst: async ({ where, include }: any) => {
        const i = db.infractions.find((x) => matches(x, where));
        if (!i) return null;
        return include ? { ...i, spot: db.spots.find((s) => s.id === i.spotId) ?? null, zone: db.zones.find((z) => z.id === i.zoneId) ?? null } : { ...i };
      },
      create: async ({ data }: any) => {
        const i = touch({ id: newId('inf'), number: ++infractionNumber, status: 'PENDIENTE', createdAt: new Date(), ...data });
        db.infractions.push(i);
        return { ...i, spot: db.spots.find((s) => s.id === i.spotId) ?? null, zone: db.zones.find((z) => z.id === i.zoneId) ?? null };
      },
      aggregate: async () => ({ _max: { updatedAt: maxUpdated(db.infractions) } }),
    },
    $transaction: async (fn: any) => fn(prisma),
  };

  function seed() {
    db.zones.length = db.spots.length = db.tickets.length = db.infractions.length = 0;
    infractionNumber = 0;
    db.zones.push({ id: 'z1', name: 'Zona Parque Benito Juarez', latitude: 17.9167, longitude: -94.0833, radiusM: 100, ratePerHour: 15, currency: 'MXN' });
    for (const n of ['A-01', 'A-02', 'A-03']) db.spots.push(touch({ id: `s-${n}`, zoneId: 'z1', number: n, status: 'FREE' }));
  }

  return { db, prisma, seed };
}

export const fake = createFakeDb();

// Reemplaza el módulo src/lib/prisma en la caché de Node antes de que lo carguen los controladores.
export function installFakePrisma(prismaModulePath: string) {
  require.cache[prismaModulePath] = {
    id: prismaModulePath,
    filename: prismaModulePath,
    loaded: true,
    exports: { prisma: fake.prisma },
  } as any;
}

// Respuesta de Express simulada
export function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

export async function call(handler: any, req: any) {
  const res = mockRes();
  let error: any;
  await handler(req, res, (e: any) => { error = e; });
  if (error) throw error;
  return res;
}
