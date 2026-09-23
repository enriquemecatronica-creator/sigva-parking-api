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
const reports = require('../src/lib/reports') as typeof import('../src/lib/reports');
const account = require('../src/controllers/account.controller') as typeof import('../src/controllers/account.controller');
const pagos = require('../src/controllers/payments.controller') as typeof import('../src/controllers/payments.controller');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bcrypt = require('bcryptjs');

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

describe('Reportes (hora de México)', () => {
  test('el día y la hora se toman en hora de México, no en UTC', () => {
    assert.equal(reports.dayKey(new Date('2026-09-23T05:00:00Z')), '2026-09-22'); // 23:00 del 22 en México
    assert.equal(reports.hourOf(new Date('2026-09-23T16:30:00Z')), 10);
    assert.equal(reports.startOfDayLocal(new Date('2026-09-23T20:00:00Z')).toISOString(), '2026-09-23T06:00:00.000Z');
  });
  test('recaudación por día y ocupación por hora', () => {
    const now = new Date('2026-09-23T23:00:00Z'); // 17:00 en México
    const tickets = [
      // 10:00 a 11:30 (México), pagó $22.50
      { entryTime: new Date('2026-09-23T16:00:00Z'), exitTime: new Date('2026-09-23T17:30:00Z'), scheduledEnd: null, status: 'COMPLETED', amountPaid: 22.5, autoReleased: false, zoneId: 'z1' },
      // ayer 12:00 a 12:15, liberado automáticamente
      { entryTime: new Date('2026-09-22T18:00:00Z'), exitTime: new Date('2026-09-22T18:15:00Z'), scheduledEnd: null, status: 'COMPLETED', amountPaid: 3.75, autoReleased: true, zoneId: 'z1' },
    ];
    const r = reports.buildReport(tickets, [{ id: 'z1', name: 'Zona Parque', spots: 10 }], [{ createdAt: new Date('2026-09-23T18:00:00Z'), amount: 250, status: 'PENDIENTE' }], 2, now);
    assert.deepEqual(r.porDia.map((d) => [d.fecha, d.recaudacion, d.sesiones, d.infracciones]), [['2026-09-22', 3.75, 1, 0], ['2026-09-23', 22.5, 1, 1]]);
    assert.equal(r.resumen.recaudacion, 26.25);
    assert.equal(r.resumen.liberadasAutomaticamente, 1);
    assert.equal(r.resumen.duracionPromedioMin, 53); // (90 + 15) / 2
    assert.equal(r.ocupacionPorHora[10].cajonesPromedio, 0.5); // 60 min / (60 × 2 días)
    assert.equal(r.ocupacionPorHora[11].cajonesPromedio, 0.25);
    assert.equal(r.ocupacionPorHora[12].cajonesPromedio, 0.13); // 15 min / 120
    assert.equal(r.porZona[0].sesiones, 2);
  });
});

describe('Zonas (dashboard)', () => {
  const editar = (body: any) => call(admin.updateAdminZone, { params: { id: 'z1' }, body });

  test('lista zonas con tarifa, horario y cajones libres', async () => {
    const res = await call(admin.getAdminZonas, {});
    const z = res.body.data[0];
    assert.equal(z.tarifaHora, 15);
    assert.equal(z.horaApertura, '08:00');
    assert.equal(z.cajones, 3);
    assert.equal(z.libres, 3);
  });
  test('cambia tarifa, horario y ubicación', async () => {
    const res = await editar({ tarifaHora: 12.5, horaApertura: '07:30', horaCierre: '21:00', latitud: 17.91, longitud: -94.09, radioM: 150 });
    assert.equal(res.statusCode, 200);
    assert.deepEqual([res.body.data.tarifaHora, res.body.data.horaApertura, res.body.data.horaCierre, res.body.data.radioM], [12.5, '07:30', '21:00', 150]);
    // El costo de una sesión nueva usa la tarifa nueva
    const t = await call(parking.createTicket, { body: { spotId: 's-A-01', licensePlate: 'XYZ123A', minutes: 60 }, userId: USER });
    assert.equal(t.body.data.amountPaid, 12.5);
  });
  test('rechaza datos inválidos', async () => {
    assert.equal((await editar({ tarifaHora: -1 })).statusCode, 400);
    assert.equal((await editar({ horaApertura: '25:00' })).statusCode, 400);
    assert.equal((await editar({ radioM: 5 })).statusCode, 400);
    assert.equal((await editar({})).statusCode, 400);
  });
  test('la infracción guarda quién la registró desde el SIGVA', async () => {
    const res = await call(infr.createInfraction, { body: { placa: 'ABC987Z' }, headers: { 'x-sigva-user': 'manuel' } });
    assert.equal(res.body.data.registradaPor, 'sigva:manuel');
  });
});

describe('Mi cuenta y recuperar contraseña', () => {
  const U = 'u1';
  let enviados: any[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    fake.db.users.push({ id: U, email: 'conductor@sigva.mx', name: 'Juan', phone: null, role: 'DRIVER', createdAt: new Date(), savedPlates: [], password: await bcrypt.hash('Viejo1234', 4) });
    enviados = [];
    process.env.RESEND_API_KEY = 're_test';
    process.env.MAIL_FROM = 'SIGVA <no-responder@sigva.mx>';
    (globalThis as any).fetch = async (_url: string, init: any) => { enviados.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '' }; };
  });
  const restaurar = () => { (globalThis as any).fetch = realFetch; delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM; };

  test('guarda nombre, teléfono y placas (sin repetir, normalizadas)', async () => {
    const res = await call(account.updateMe, { userId: U, body: { name: 'Juan Pérez', phone: '924 100 0000', placas: ['xyz-123-a', 'XYZ123A', 'abc 987 z'] } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.user.placas, ['XYZ123A', 'ABC987Z']);
    assert.equal(res.body.user.phone, '9241000000');
    assert.equal((await call(account.updateMe, { userId: U, body: { placas: ['1', '2', '3', '4', '5', '6'].map((n) => 'ABC12' + n) } })).statusCode, 400);
    restaurar();
  });
  test('cambiar contraseña exige la actual', async () => {
    assert.equal((await call(account.changePassword, { userId: U, body: { actual: 'mala', nueva: 'Nueva12345' } })).statusCode, 400);
    assert.equal((await call(account.changePassword, { userId: U, body: { actual: 'Viejo1234', nueva: 'Nueva12345' } })).statusCode, 200);
    assert.ok(await bcrypt.compare('Nueva12345', fake.db.users[0].password));
    restaurar();
  });
  test('recuperar: manda código y permite cambiar la contraseña una sola vez', async () => {
    const r1 = await call(account.forgotPassword, { body: { email: 'CONDUCTOR@sigva.mx' } });
    assert.equal(r1.statusCode, 200);
    assert.equal(enviados.length, 1);
    const codigo = String(enviados[0].text.match(/\b\d{6}\b/)[0]);
    assert.equal((await call(account.resetPassword, { body: { email: 'conductor@sigva.mx', codigo: '000000' === codigo ? '111111' : '000000', nueva: 'Otra12345' } })).statusCode, 400);
    const ok = await call(account.resetPassword, { body: { email: 'conductor@sigva.mx', codigo, nueva: 'Otra12345' } });
    assert.equal(ok.statusCode, 200);
    assert.ok(await bcrypt.compare('Otra12345', fake.db.users[0].password));
    assert.equal((await call(account.resetPassword, { body: { email: 'conductor@sigva.mx', codigo, nueva: 'Otra99999' } })).statusCode, 400);
    restaurar();
  });
  test('correo no registrado: misma respuesta y no se envía nada', async () => {
    const r = await call(account.forgotPassword, { body: { email: 'nadie@x.mx' } });
    assert.equal(r.statusCode, 200);
    assert.equal(enviados.length, 0);
    restaurar();
  });
  test('bloquea el código después de 5 intentos fallidos', async () => {
    await call(account.forgotPassword, { body: { email: 'conductor@sigva.mx' } });
    const codigo = String(enviados[0].text.match(/\b\d{6}\b/)[0]);
    const malo = codigo === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await call(account.resetPassword, { body: { email: 'conductor@sigva.mx', codigo: malo, nueva: 'Otra12345' } });
    assert.equal((await call(account.resetPassword, { body: { email: 'conductor@sigva.mx', codigo, nueva: 'Otra12345' } })).statusCode, 400);
    restaurar();
  });
  test('sin servicio de correo configurado responde 503', async () => {
    restaurar();
    assert.equal((await call(account.forgotPassword, { body: { email: 'conductor@sigva.mx' } })).statusCode, 503);
  });
});

describe('Mercado Pago (listo para conectar)', () => {
  const realFetch = globalThis.fetch;
  let mpPago: any = null;
  let reembolsos: string[] = [];
  let preferencias: any[] = [];

  beforeEach(() => {
    process.env.PAYMENT_PROVIDER = 'mercadopago';
    process.env.MP_ACCESS_TOKEN = 'TEST-token';
    process.env.PUBLIC_API_URL = 'https://api.test';
    delete process.env.MP_WEBHOOK_SECRET;
    mpPago = null; reembolsos = []; preferencias = [];
    fake.db.users.push({ id: USER, email: 'conductor@sigva.mx', name: 'Juan', role: 'DRIVER', savedPlates: [], password: 'x' });
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      const json = (d: any) => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
      if (url.endsWith('/checkout/preferences')) { preferencias.push(JSON.parse(init.body)); return json({ id: 'pref-1', init_point: 'https://mp.test/pagar' }); }
      if (url.includes('/refunds')) { reembolsos.push(url); return json({ id: 1 }); }
      if (url.includes('/v1/payments/')) return json(mpPago);
      throw new Error('URL inesperada ' + url);
    };
  });
  const fin = () => { (globalThis as any).fetch = realFetch; delete process.env.PAYMENT_PROVIDER; delete process.env.MP_ACCESS_TOKEN; delete process.env.PUBLIC_API_URL; };
  const iniciar = () => call(parking.createTicket, { body: { spotId: 's-A-01', licensePlate: 'XYZ123A', minutes: 45 }, userId: USER });
  const avisar = (id = '777', headers: any = {}) => call(pagos.mercadoPagoWebhook, { body: { type: 'payment', data: { id } }, query: {}, headers });

  test('iniciar aparta el cajón y regresa la liga de pago', async () => {
    const r = await iniciar();
    assert.equal(r.statusCode, 202);
    assert.equal(r.body.data.status, 'pending_payment');
    assert.equal(r.body.data.pago.checkoutUrl, 'https://mp.test/pagar');
    assert.equal(fake.db.spots.find((s) => s.id === 's-A-01')!.status, 'RESERVED');
    assert.equal(preferencias[0].items[0].unit_price, 11.25);
    assert.equal(preferencias[0].notification_url, 'https://api.test/api/v1/pagos/webhook');
    fin();
  });
  test('pago aprobado activa la sesión y ocupa el cajón (una sola vez)', async () => {
    const r = await iniciar();
    mpPago = { id: 777, status: 'approved', external_reference: r.body.data.pago.id, transaction_amount: 11.25, payment_type_id: 'credit_card' };
    assert.equal((await avisar()).body.resultado, 'activado');
    const t = fake.db.tickets[0];
    assert.equal(t.status, 'ACTIVE');
    assert.equal(t.amountPaid, 11.25);
    assert.equal(t.paymentMethod, 'CARD');
    assert.ok(t.scheduledEnd > new Date());
    assert.equal(fake.db.spots.find((s) => s.id === 's-A-01')!.status, 'OCCUPIED');
    assert.equal((await avisar()).body.resultado, 'ya_procesado');
    fin();
  });
  test('pago rechazado libera el cajón', async () => {
    const r = await iniciar();
    mpPago = { id: 778, status: 'rejected', external_reference: r.body.data.pago.id, transaction_amount: 11.25 };
    assert.equal((await avisar('778')).body.resultado, 'rechazado');
    assert.equal(fake.db.tickets[0].status, 'CANCELLED');
    assert.equal(fake.db.spots.find((s) => s.id === 's-A-01')!.status, 'FREE');
    fin();
  });
  test('si pagó tarde (cajón ya liberado) se reembolsa solo', async () => {
    const r = await iniciar();
    fake.db.tickets[0].createdAt = minutesAgo(20);
    assert.equal(await pagos.expirePendingPayments(), 1);
    assert.equal(fake.db.spots.find((s) => s.id === 's-A-01')!.status, 'FREE');
    mpPago = { id: 779, status: 'approved', external_reference: r.body.data.pago.id, transaction_amount: 11.25, payment_type_id: 'ticket' };
    assert.equal((await avisar('779')).body.resultado, 'reembolsado');
    assert.equal(reembolsos.length, 1);
    fin();
  });
  test('monto menor al esperado no activa y se reembolsa', async () => {
    const r = await iniciar();
    mpPago = { id: 780, status: 'approved', external_reference: r.body.data.pago.id, transaction_amount: 1, payment_type_id: 'credit_card' };
    assert.equal((await avisar('780')).body.resultado, 'monto_incorrecto');
    assert.equal(fake.db.tickets[0].status, 'PENDING_PAYMENT');
    fin();
  });
  test('extender con pago suma el tiempo al aprobarse', async () => {
    const r = await iniciar();
    mpPago = { id: 781, status: 'approved', external_reference: r.body.data.pago.id, transaction_amount: 11.25, payment_type_id: 'credit_card' };
    await avisar('781');
    const ext = await call(parking.extendTicket, { params: { id: fake.db.tickets[0].id }, body: { minutes: 15 }, userId: USER });
    assert.equal(ext.statusCode, 202);
    assert.equal(fake.db.tickets[0].plannedMinutes, 45); // todavía no se suma
    mpPago = { id: 782, status: 'approved', external_reference: ext.body.data.pago.id, transaction_amount: 3.75, payment_type_id: 'account_money' };
    assert.equal((await avisar('782')).body.resultado, 'extendido');
    assert.equal(fake.db.tickets[0].plannedMinutes, 60);
    assert.equal(fake.db.tickets[0].amountPaid, 15);
    fin();
  });
  test('firma de Mercado Pago inválida se rechaza', async () => {
    process.env.MP_WEBHOOK_SECRET = 'secreto';
    await iniciar();
    assert.equal((await avisar('783', { 'x-signature': 'ts=1,v1=malo', 'x-request-id': 'r1' })).statusCode, 401);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('crypto');
    const v1 = crypto.createHmac('sha256', 'secreto').update('id:783;request-id:r1;ts:1;').digest('hex');
    mpPago = { id: 783, status: 'pending', external_reference: fake.db.payments[0].id, transaction_amount: 11.25 };
    assert.equal((await avisar('783', { 'x-signature': `ts=1,v1=${v1}`, 'x-request-id': 'r1' })).statusCode, 200);
    delete process.env.MP_WEBHOOK_SECRET;
    fin();
  });
  test('sin Mercado Pago configurado todo sigue con pago simulado', async () => {
    fin();
    const r = await iniciar();
    assert.equal(r.statusCode, 201);
    assert.equal(r.body.data.status, 'active');
  });
});
