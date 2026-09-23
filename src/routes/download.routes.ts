// backend/src/routes/download.routes.ts
// Destino fijo de los QR de cada zona: GET /descargar?zona=MTY01A
// Redirige a la tienda según el teléfono (APP_DOWNLOAD_ANDROID_URL / APP_DOWNLOAD_IOS_URL).
// Si las tiendas aún no están configuradas, muestra una página "Próximamente".

import { Router, Request, Response } from 'express';
import { normalizeQrCode } from '../lib/parking';

const router = Router();

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

router.get('/', (req: Request, res: Response) => {
  const zona = normalizeQrCode(String(req.query.zona ?? '')) ?? '';
  const ua = String(req.headers['user-agent'] ?? '');
  const android = process.env.APP_DOWNLOAD_ANDROID_URL || '';
  const ios = process.env.APP_DOWNLOAD_IOS_URL || '';

  console.log(`📲 QR descarga escaneado zona=${zona || '-'} ua=${/android/i.test(ua) ? 'android' : /iphone|ipad|ipod/i.test(ua) ? 'ios' : 'otro'}`);

  if (/android/i.test(ua) && android) return res.redirect(302, android);
  if (/iphone|ipad|ipod/i.test(ua) && ios) return res.redirect(302, ios);

  const links = [
    android && `<a class="btn" href="${escapeHtml(android)}">Descargar para Android</a>`,
    ios && `<a class="btn" href="${escapeHtml(ios)}">Descargar para iPhone</a>`,
  ].filter(Boolean).join('');

  res.type('html').send(`<!doctype html>
<html lang="es-MX"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SIGVA Parquímetro</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e6edf7;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
  main{max-width:420px;width:100%;text-align:center}
  h1{font-size:24px;margin:0 0 8px}
  p{color:#9fb0c8;line-height:1.5;margin:0 0 20px}
  .btn{display:block;background:#2563eb;color:#fff;text-decoration:none;padding:14px;border-radius:10px;font-weight:600;margin:10px 0}
  .zona{font-size:13px;color:#6b7c96;margin-top:20px}
</style></head>
<body><main>
  <h1>SIGVA Parquímetro</h1>
  <p>Paga tu estacionamiento en la calle desde tu celular. La app detecta tu zona con el GPS; no necesitas buscar un parquímetro.</p>
  ${links || '<p><strong>La app estará disponible muy pronto</strong> en Google Play y App Store.</p>'}
  ${zona ? `<div class="zona">Zona ${escapeHtml(zona)}</div>` : ''}
</main></body></html>`);
});

export default router;
