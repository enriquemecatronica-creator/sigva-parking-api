// backend/prisma/seed.ts — Datos iniciales SIGVA Las Choapas

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Sembrando datos iniciales...');

  const adminPassword = await bcrypt.hash('Admin123!', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@sigva.mx' },
    update: {},
    create: {
      email: 'admin@sigva.mx',
      name: 'Administrador SIGVA',
      password: adminPassword,
      role: 'ADMIN',
    },
  });
  console.log('Admin:', admin.email);

  const driverPassword = await bcrypt.hash('Driver123!', 12);
  const driver = await prisma.user.upsert({
    where: { email: 'conductor@sigva.mx' },
    update: {},
    create: {
      email: 'conductor@sigva.mx',
      name: 'Juan Conductor',
      phone: '+52 924 100 0000',
      password: driverPassword,
      role: 'DRIVER',
    },
  });
  console.log('Conductor:', driver.email);

  // Zona 1 - Parque Benito Juarez
  const zona1 = await prisma.parkingZone.upsert({
    where: { id: 'zone-parque-choapas' },
    update: {},
    create: {
      id: 'zone-parque-choapas',
      name: 'Zona Parque Benito Juarez',
      address: 'Alrededores del Parque Central Benito Juarez, Las Choapas, Ver.',
      latitude: 17.9167,
      longitude: -94.0833,
      totalSpots: 20,
      ratePerHour: 10.0,
      openTime: '08:00',
      closeTime: '20:00',
    },
  });
  const spots1 = ['A-01','A-02','A-03','A-04','A-05','A-06','A-07','A-08','A-09','A-10','B-01','B-02','B-03','B-04','B-05','B-06','B-07','B-08','B-09','B-10'];
  for (const num of spots1) {
    await prisma.parkingSpot.upsert({
      where: { zoneId_number: { zoneId: zona1.id, number: num } },
      update: {},
      create: { zoneId: zona1.id, number: num, status: Math.random() > 0.4 ? 'FREE' : 'OCCUPIED' },
    });
  }
  console.log('Zona Parque Benito Juarez:', spots1.length, 'cajones');

  // Zona 2 - Av. 20 de Noviembre
  const zona2 = await prisma.parkingZone.upsert({
    where: { id: 'zone-20nov-choapas' },
    update: {},
    create: {
      id: 'zone-20nov-choapas',
      name: 'Zona Av. 20 de Noviembre',
      address: 'Av. 20 de Noviembre, Centro, Las Choapas, Ver.',
      latitude: 17.9175,
      longitude: -94.0845,
      totalSpots: 15,
      ratePerHour: 10.0,
      openTime: '08:00',
      closeTime: '20:00',
    },
  });
  const spots2 = ['N-01','N-02','N-03','N-04','N-05','N-06','N-07','N-08','N-09','N-10','N-11','N-12','N-13','N-14','N-15'];
  for (const num of spots2) {
    await prisma.parkingSpot.upsert({
      where: { zoneId_number: { zoneId: zona2.id, number: num } },
      update: {},
      create: { zoneId: zona2.id, number: num, status: Math.random() > 0.5 ? 'FREE' : 'OCCUPIED' },
    });
  }
  console.log('Zona Av. 20 de Noviembre:', spots2.length, 'cajones');

  // Zona 3 - Calle Miguel Hidalgo
  const zona3 = await prisma.parkingZone.upsert({
    where: { id: 'zone-hidalgo-choapas' },
    update: {},
    create: {
      id: 'zone-hidalgo-choapas',
      name: 'Zona Calle Miguel Hidalgo',
      address: 'Calle Miguel Hidalgo, Centro, Las Choapas, Ver.',
      latitude: 17.9158,
      longitude: -94.0822,
      totalSpots: 12,
      ratePerHour: 10.0,
      openTime: '08:00',
      closeTime: '20:00',
    },
  });
  const spots3 = ['H-01','H-02','H-03','H-04','H-05','H-06','H-07','H-08','H-09','H-10','H-11','H-12'];
  for (const num of spots3) {
    await prisma.parkingSpot.upsert({
      where: { zoneId_number: { zoneId: zona3.id, number: num } },
      update: {},
      create: { zoneId: zona3.id, number: num, status: Math.random() > 0.5 ? 'FREE' : 'OCCUPIED' },
    });
  }
  console.log('Zona Calle Miguel Hidalgo:', spots3.length, 'cajones');

  console.log('\nDatos listos! 47 cajones en 3 zonas de Las Choapas, Ver.');
  console.log('Admin:     admin@sigva.mx / Admin123!');
  console.log('Conductor: conductor@sigva.mx / Driver123!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
