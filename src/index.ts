// backend/src/index.ts — Punto de entrada del servidor SIGVA

import 'dotenv/config';
import app from './app';

const PORT = process.env.PORT ?? 3000;

app.listen(PORT, () => {
  console.log(`🚀 SIGVA API corriendo en http://localhost:${PORT}`);
  console.log(`📋 Ambiente: ${process.env.NODE_ENV ?? 'development'}`);
});
