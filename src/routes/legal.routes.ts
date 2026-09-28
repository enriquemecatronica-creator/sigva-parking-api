// backend/src/routes/legal.routes.ts
// Páginas públicas que piden App Store y Google Play:
//   GET /privacidad        Aviso de privacidad
//   GET /terminos          Términos de uso
//   GET|POST /eliminar-cuenta  Eliminar la cuenta desde la web
// Datos del responsable en variables de Railway (mientras falten, se muestra
// un aviso de "versión preliminar"):
//   LEGAL_RESPONSABLE  nombre de la persona o entidad responsable
//   LEGAL_CONTACTO     correo para dudas y derechos ARCO
//   LEGAL_DOMICILIO    domicilio para oír y recibir notificaciones

import { Router, Request, Response } from 'express';
import { deleteAccountPage, legalShell } from '../controllers/account.controller';
import { parkingConfig } from '../lib/parking';

const router = Router();
const ACTUALIZADO = '28 de septiembre de 2026';

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function datosLegales() {
  const responsable = process.env.LEGAL_RESPONSABLE?.trim();
  const contacto = process.env.LEGAL_CONTACTO?.trim();
  const domicilio = process.env.LEGAL_DOMICILIO?.trim();
  return {
    completo: !!(responsable && contacto && domicilio),
    responsable: esc(responsable || '[Nombre del responsable]'),
    contacto: contacto ? `<a href="mailto:${esc(contacto)}">${esc(contacto)}</a>` : '[correo de contacto]',
    domicilio: esc(domicilio || '[domicilio]'),
  };
}

const borrador = (completo: boolean) =>
  completo ? '' : '<p class="draft">Versión preliminar: faltan los datos del responsable. Este texto se completará antes de publicar la app en las tiendas.</p>';

router.get('/privacidad', (_req: Request, res: Response) => {
  const d = datosLegales();
  res.type('html').send(legalShell('Aviso de privacidad', `
<p class="meta">SIGVA Parquímetro · Última actualización: ${ACTUALIZADO}</p>
${borrador(d.completo)}
<h2>1. Responsable</h2>
<p>${d.responsable}, con domicilio en ${d.domicilio}, es responsable del tratamiento de los datos personales que proporcionas al usar la app SIGVA Parquímetro, conforme a la legislación mexicana de protección de datos personales. Contacto: ${d.contacto}.</p>

<h2>2. Datos que recabamos</h2>
<ul>
  <li><b>Cuenta:</b> nombre, correo electrónico, teléfono (opcional) y contraseña (se guarda cifrada; nadie puede leerla).</li>
  <li><b>Vehículo:</b> las placas que capturas al estacionarte y las que decides guardar en tu cuenta.</li>
  <li><b>Ubicación:</b> tu ubicación aproximada y su precisión <b>solo en el momento</b> en que inicias una sesión o buscas zonas cercanas, para confirmar en qué zona estás. La app no rastrea tu ubicación en segundo plano.</li>
  <li><b>Sesiones y pagos:</b> zona, cajón, horario, minutos, importe, estado del pago y comprobantes. Los pagos con tarjeta los procesa Mercado Pago; nosotros no recibimos ni guardamos los datos de tu tarjeta.</li>
  <li><b>Datos técnicos:</b> dirección IP y registros de acceso para seguridad y para evitar abusos; y, en las versiones instaladas desde las tiendas, tiempos de arranque de la app y reportes de errores, asociados a un identificador anónimo de la instalación (no a tu nombre ni a tu cuenta).</li>
</ul>
<p>No recabamos datos personales sensibles.</p>

<h2>3. Para qué los usamos</h2>
<p><b>Finalidades necesarias:</b> crear y administrar tu cuenta; confirmar la zona en la que te estacionas; cobrar el tiempo, emitir comprobantes y atender aclaraciones o reembolsos; permitir que el personal de inspección verifique si una placa tiene tiempo pagado; avisarte cuando tu tiempo esté por vencer; recuperar tu contraseña; y cumplir obligaciones legales, contables y de seguridad.</p>
<p><b>Finalidad adicional:</b> generar estadísticas agregadas y sin datos que te identifiquen (por ejemplo, ocupación por hora) para mejorar el servicio y la movilidad. Si no quieres que tus datos se usen para esto, escríbenos a ${d.contacto}; no afectará tu uso de la app.</p>

<h2>4. Con quién los compartimos</h2>
<ul>
  <li><b>Autoridad de movilidad o tránsito</b> del municipio donde te estacionas: placa, zona, cajón y vigencia del pago, para la verificación en calle y, en su caso, infracciones.</li>
  <li><b>Mercado Pago:</b> importe y referencia del pago, para procesarlo.</li>
  <li><b>Proveedores que nos dan servicio</b> y que solo pueden usar los datos para ello: alojamiento de servidores y base de datos (Railway, Estados Unidos), distribución, actualización y medición del rendimiento de la app (Expo, Estados Unidos) y envío de correos (Resend).</li>
  <li><b>Autoridades competentes</b> cuando la ley lo requiera.</li>
</ul>
<p>No vendemos tus datos personales.</p>

<h2>5. Cuánto tiempo los conservamos</h2>
<p>Los datos de tu cuenta se conservan mientras la tengas activa. Si eliminas tu cuenta, borramos de inmediato tu nombre, correo, teléfono, placas guardadas y contraseña. Los registros de sesiones, pagos e infracciones se conservan sin tus datos de contacto durante el tiempo que exijan las obligaciones fiscales, contables y de aclaraciones.</p>

<h2>6. Tus derechos</h2>
<p>Puedes acceder a tus datos, corregirlos, cancelarlos u oponerte a su uso (derechos ARCO), así como revocar tu consentimiento, escribiendo a ${d.contacto} con tu nombre, el correo de tu cuenta y lo que solicitas. Te responderemos en los plazos que marca la ley. Desde la app puedes corregir tus datos en <b>Perfil → Mi cuenta</b> y eliminar tu cuenta en cualquier momento (también en <a href="/eliminar-cuenta">esta página</a>).</p>

<h2>7. Seguridad</h2>
<p>La información viaja cifrada (HTTPS), las contraseñas se guardan con cifrado de un solo sentido y el acceso a los datos está limitado al personal autorizado.</p>

<h2>8. Cambios a este aviso</h2>
<p>Si cambiamos este aviso, publicaremos la nueva versión en esta página y te lo avisaremos en la app.</p>
`));
});

router.get('/terminos', (_req: Request, res: Response) => {
  const d = datosLegales();
  const cfg = parkingConfig;
  res.type('html').send(legalShell('Términos de uso', `
<p class="meta">SIGVA Parquímetro · Última actualización: ${ACTUALIZADO}</p>
${borrador(d.completo)}
<h2>1. El servicio</h2>
<p>SIGVA Parquímetro te permite pagar desde tu celular el estacionamiento en la vía pública en las zonas donde el servicio opera. Al crear una cuenta aceptas estos términos. Responsable del servicio: ${d.responsable} (${d.contacto}).</p>

<h2>2. Cómo funciona el pago</h2>
<ul>
  <li>La tarifa se muestra en la app antes de pagar y la define cada zona.</li>
  <li>El tiempo se contrata en bloques de ${cfg.stepMinutes} minutos, de ${cfg.minMinutes} a ${cfg.maxMinutes} minutos por sesión. Puedes extenderlo sin pasar del máximo.</li>
  <li>La zona se confirma con la ubicación de tu teléfono. Eres responsable de capturar correctamente la placa y el cajón.</li>
  <li>Tu tiempo queda activo cuando el pago se confirma. Si el pago no se confirma en unos minutos, la sesión se cancela y el cajón se libera.</li>
</ul>

<h2>3. Al terminar tu tiempo</h2>
<p>Te avisamos antes de que venza. Si el tiempo vence y no terminaste la sesión, el vehículo aparecerá como vencido para el personal de inspección, que puede aplicar la sanción que corresponda según el reglamento municipal. Pasado un plazo, el sistema cierra la sesión automáticamente; esto no cancela una infracción ya levantada.</p>

<h2>4. Aclaraciones y reembolsos</h2>
<p>Si un cobro no es correcto, escríbenos a ${d.contacto} con la fecha, la placa y el comprobante que aparece en la app. Si un pago no pudo aplicarse a tu sesión por una falla del sistema, se reembolsa por el mismo medio de pago.</p>

<h2>5. Tu cuenta</h2>
<p>Cuida tu contraseña; eres responsable del uso de tu cuenta. Puedes eliminarla cuando quieras desde la app o en <a href="/eliminar-cuenta">esta página</a>. Podemos suspender cuentas usadas para fraude, suplantación o para afectar el servicio.</p>

<h2>6. Disponibilidad</h2>
<p>Buscamos que el servicio esté disponible siempre, pero puede haber interrupciones por mantenimiento o fallas de red. Si no puedes pagar por una falla de la app, sigue las indicaciones del personal de inspección o de los señalamientos de la zona.</p>

<h2>7. Privacidad</h2>
<p>El uso de tus datos se explica en el <a href="/privacidad">Aviso de privacidad</a>.</p>

<h2>8. Cambios y ley aplicable</h2>
<p>Podemos actualizar estos términos; la versión vigente siempre estará en esta página. Estos términos se rigen por las leyes de los Estados Unidos Mexicanos.</p>
`));
});

router.get('/eliminar-cuenta', deleteAccountPage);
router.post('/eliminar-cuenta', deleteAccountPage);

export default router;
