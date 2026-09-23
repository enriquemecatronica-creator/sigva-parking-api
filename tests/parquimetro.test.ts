// tests/parquimetro.test.ts — pruebas del parquímetro sin base de datos real.
// Correr con:  npm test

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fake, installFakePrisma, call } from './helpers/fakePrisma';

// La base en memoria reemplaza a Prisma ANTES de cargar el código de la API
installFakePrisma(require.resolve(path.join(__dirname, '../src/lib/prisma')));

/* eslint-disable @typescript-eslint/no-var-requires */
const lib = require('../src/lib/parking') as typeof import('../src/lib/parking');
const parking = require('../src/controllers/parking.controller') as typeof import('../src/controllers/parking.controller');
const infr = require('../src/controllers/infraction.controller') as typeof import('../src/controllers/infraction.controller');
const auto = require('../src/lib/autoRelease') as typeof import('../src/lib/autoRelease');
const admin = require('../src/controllers/admin.controller') as typeof import('../src/controllers/admin.controller');

const USER = 'u1';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60000);

beforeEach(() => {
  fake.seed();
  delete process.env.GPS_VALIDATION_ENABLED;
  delete process.env.AUTO_RELEASE_MINUTES;
  delete process.env.INFRACCION_MONTO;
});

describe('Tiempo y tarifa', () => {
  test('acepta bloques de 15 min de 15 a 120', () => {
    for (const m of [15, 30, 45, 60, 75, 90, 105, 120]) assert.equal(lib.validateMinutes(m).ok, true, `${m}`);
  });
  test('rechaza tiempos fuera de bloque o de rango', () => {
    for (const m of [0, 10, 20, 50, 135, 150, -15, 'abc']) assert.equal(lib.validateMinutes(m).ok, false, `${m}`);
  });
  test('costo con tarifa de $15 por hora', () => {
    assert.equal(lib.costFor(15, 15), 3.75);
    assert.equal(lib.costFor(30, 15), 7.5);
    assert.equal(lib.costFor(45, 15), 11.25);
    assert.equal(lib.costFor(60, 15), 15);
    assert.equal(lib.costFor(120, 15), 30);
  });
});

describe('GPS', () => {
  const zona = { lat: 17.9167, lng: -94.0833, radiusM: 100 };
  test('distancia Haversine razonable (~111 m por milésima de grado)', () => {
    const d = lib.haversineM(17.9167, -94.0833, 17.9177, -94.0833);
    assert.ok(d > 100 && d < 120, String(d));
  });
  test('con validación apagada nunca bloquea, pero informa', () => {
    const r = lib.evaluateGps({ lat: 18.5, lng: -94.0833, accuracy: 5 }, zona);
    assert.equal(r.ok, true);
    assert.ok(r.reason);
  });
  test('con validación encendida bloquea fuera del radio y acepta dentro', () => {
    process.env.GPS_VALIDATION_ENABLED = 'true';
    assert.equal(lib.evaluateGps({ lat: 17.9187, lng: -94.0833, accuracy: 5 }, zona).ok, false);
    assert.equal(lib.evaluateGps({ lat: 17.9168, lng: -94.0833, accuracy: 5 }, zona).ok, true);
    assert.equal(lib.evaluateGps({ lat: 17.9168, lng: -94.0833, accuracy: 60 }, zona).ok, false);
  });
  test('código QR se normaliza desde URL', () => {
    assert.equal(lib.normalizeQrCode('https://x.app/descargar?zona=mty03a'), 'MTY03A');
    assert.equal(lib.normalizeQrCode('??'), null);
  });
});

describe('Sesiones', () => {
  const start = (body: any, userId = USER) => call(parking.createTicket, { body, userId });

  test('inicia sesión de 45 min, cobra $11.25 y ocupa el cajón', async () => {
    const res = await start({ spotId: 's-A-01', licensePlate: 'xyz 123 a', minutes: 45 });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.amountPaid, 11.25);
    assert.equal(res.body.data.plannedMinutes, 45);
    assert.equal(res.body.data.licensePlate, 'XYZ123A');
    assert.equal(fake.db.spots.find((s) => s.id === 's-A-01')!.status, 'OCCUPIED');
  });
  test('rechaza 20 minutos', async () => {
    const res = await start({ spotId: 's-A-01', licensePlate: 'XYZ123A', minutes: 20 });
    assert.equal(res.statusCode, 400);
  });
  test('no deja tomar un cajón ocupado', async () => {
    await start({ spotId: 's-A-01', licensePlate: 'XYZ123A', minutes: 15 });
    const res = await start({ spotId: 's-A-01', licensePlate: 'ABC987Z', minutes: 15 }, 'u2');
    assert.equal(res.statusCode, 409);
  });
  test('un usuario no puede tener dos sesiones activas', async () => {
    await start({ spotId: 's-A-01', licensePlate: 'XYZ123A', minutes: 15 });
    const res = await start({ spotId: 's-A-02', licensePlate: 'XYZ123A', minutes: 15 });
    assert.equal(res.statusCode, 409);
  });
  test('extender +15 suma tiempo y cobra $3.75', async () => {
    const t = (await start({ spotId: 's-A-01', licensePlate: 'XYZ123A', minutes: 45 })).body.data;
    const res = await call(parking.extendTicket, { params: { id: t.id }, body: { minutes: 15 }, userId: USER });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.plannedMinutes, 60);
    assert.equal(res.body.data.charged, 3.75);
    assert.equal(res.body.data.amountPaid, 15);
  });
  test('no permite pasar de 2 horas', async () => {
    const t = (await start({ spotId: 's-A-01', licensePlate: 'XYZ123A', minutes: 120 })).body.data;
    const res = await call(parking.extendTicket, { params: { id: t.id }, body: { minutes: 15 }, userId: USER });
    assert.equal(res.statusCode, 400);
  });
  test('"Ya me voy" libera el cajón y cobra solo lo pagado', async () => {
    const t = (await start({ spotId: 's-A-01', licensePlate: 'XYZ123A', minutes: 30 })).body.data;
    const res = await call(parking.closeTicket, { params: { id: t.id }, userId: USER });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.totalAmount, 7.5);
    assert.equal(fake.db.spots.find((s) => s.id === 's-A-01')!.status, 'FREE');
  });
});

describe('Liberación automática', () => {
  async function expiredTicket(minutesExpired: number, spotId = 's-A-01') {
    const t = (await call(parking.createTicket, { body: { spotId, licensePlate: 'XYZ123A', minutes: 30 }, userId: USER })).body.data;
    const row = fake.db.tickets.find((x) => x.id === t.id)!;
    row.entryTime = minutesAgo(30 + minutesExpired);
    row.scheduledEnd = minutesAgo(minutesExpired);
    return row;
  }

  test('libera el cajón vencido hace más de 30 min', async () => {
    const t = await expiredTicket(31);
    const r = await auto.releaseExpiredTickets();
    assert.equal(r.released, 1);
    assert.equal(t.status, 'COMPLETED');
    assert.equal(t.autoReleased, true);
    assert.equal(t.amountDue, 7.5);
    assert.equal(fake.db.spots.find((s) => s.id === 's-A-01')!.status, 'FREE');
  });
  test('respeta la tolerancia: vencido hace 10 min sigue ocupado', async () => {
    const t = await expiredTicket(10);
    const r = await auto.releaseExpiredTickets();
    assert.equal(r.released, 0);
    assert.equal(t.status, 'ACTIVE');
  });
  test('AUTO_RELEASE_MINUTES=0 lo apaga', async () => {
    process.env.AUTO_RELEASE_MINUTES = '0';
    await expiredTicket(500);
    assert.equal((await auto.releaseExpiredTickets()).released, 0);
  });
  test('tolerancia configurable', async () => {
    process.env.AUTO_RELEASE_MINUTES = '5';
    await expiredTicket(6);
    assert.equal((await auto.releaseExpiredTickets()).released, 1);
  });
  test('minutos para liberar que ve el inspector', () => {
    assert.equal(auto.minutesUntilRelease(-10), 20);
    assert.equal(auto.minutesUntilRelease(-45), 0);
    assert.equal(auto.minutesUntilRelease(5), null);
  });
});

describe('Infracciones', () => {
  const multar = (body: any) => call(infr.createInfraction, { body });

  test('no multa a quien tiene tiempo pagado vigente', async () => {
    await call(parking.createTicket, { body: { spotId: 's-A-01', licensePlate: 'XYZ123A', minutes: 60 }, userId: USER });
    const res = await multar({ placa: 'XYZ123A' });
    assert.equal(res.statusCode, 409);
  });
  test('tiempo vencido genera folio INF-000001 con el monto configurado', async () => {
    process.env.INFRACCION_MONTO = '250';
    const t = (await call(parking.createTicket, { body: { spotId: 's-A-01', licensePlate: 'XYZ123A', minutes: 15 }, userId: USER })).body.data;
    fake.db.tickets.find((x) => x.id === t.id)!.scheduledEnd = minutesAgo(5);
    const res = await multar({ placa: 'xyz123a' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.folio, 'INF-000001');
    assert.equal(res.body.data.tipo, 'tiempo_vencido');
    assert.equal(res.body.data.monto, 250);
  });
  test('placa sin sesión = sin pago; no duplica en la misma hora', async () => {
    const a = await multar({ placa: 'ABC987Z', spotId: 's-A-02' });
    assert.equal(a.statusCode, 201);
    assert.equal(a.body.data.tipo, 'sin_pago');
    const b = await multar({ placa: 'ABC987Z' });
    assert.equal(b.statusCode, 409);
  });
});

describe('Dashboard', () => {
  test('la versión cambia cuando se ocupa un cajón', async () => {
    const v1 = (await call(admin.getAdminVersion, {})).body.data.version;
    await new Promise((r) => setTimeout(r, 5));
    await call(parking.createTicket, { body: { spotId: 's-A-03', licensePlate: 'XYZ123A', minutes: 15 }, userId: USER });
    const v2 = (await call(admin.getAdminVersion, {})).body.data.version;
    assert.notEqual(v1, v2);
  });
});
