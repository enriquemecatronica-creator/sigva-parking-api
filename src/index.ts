// backend/src/index.ts — Punto de entrada del servidor SIGVA

import 'dotenv/config';
import app from './app';
import { ensureZoneQrCodes } from './lib/parking';

const PORT = process.env.PORT ?? 3000;

app.listen(PORT, () => {
  console.log(`🚀 SIGVA API corriendo en http://localhost:${PORT}`);
  console.log(`📋 Ambiente: ${process.env.NODE_ENV ?? 'development'}`);

  // Crea el QR principal (MTY##A) de cada zona que aún no tiene uno
  ensureZoneQrCodes()
    .then((n) => n > 0 && console.log(`🏷️  QR creados para ${n} zonas`))
    .catch((e) => console.error('No se pudieron asignar códigos QR:', e));
});
