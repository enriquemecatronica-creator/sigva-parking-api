// backend/src/lib/mailer.ts
// Envío de correos (códigos de recuperación). Usa Resend (https://resend.com, plan gratis).
// Se activa solo cuando existen RESEND_API_KEY y MAIL_FROM en Railway; si no, queda apagado.
//   RESEND_API_KEY=re_xxx
//   MAIL_FROM="SIGVA Parquímetro <no-responder@tu-dominio.mx>"

export const mailConfig = {
  get enabled() {
    return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
  },
};

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(msg: MailMessage): Promise<boolean> {
  if (!mailConfig.enabled) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!r.ok) {
      console.error('Correo no enviado:', r.status, (await r.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('Correo no enviado:', e);
    return false;
  }
}
