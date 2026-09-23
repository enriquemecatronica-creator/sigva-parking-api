// backend/src/lib/payments.ts
// Cobro con Mercado Pago (Checkout Pro). Mientras no se configure, el sistema sigue con
// pago simulado y nada cambia para la app.
//
// Para encender (variables del servicio parking-api en Railway):
//   PAYMENT_PROVIDER=mercadopago
//   MP_ACCESS_TOKEN=APP_USR-...        (credencial de producción o de prueba de Mercado Pago)
//   MP_WEBHOOK_SECRET=...              (clave secreta de las notificaciones "Webhooks")
//   PUBLIC_API_URL=https://parking-api-production-14b0.up.railway.app
//   PAYMENT_PENDING_MINUTES=15         (opcional: tiempo para pagar antes de liberar el cajón)

import crypto from 'crypto';

const MP_API = 'https://api.mercadopago.com';

export const paymentsConfig = {
  get provider(): 'mercadopago' | 'simulado' {
    return process.env.PAYMENT_PROVIDER === 'mercadopago' && process.env.MP_ACCESS_TOKEN ? 'mercadopago' : 'simulado';
  },
  get pendingMinutes(): number {
    const v = Number(process.env.PAYMENT_PENDING_MINUTES);
    return Number.isFinite(v) && v >= 5 && v <= 60 ? v : 15;
  },
  get publicUrl(): string {
    return (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  },
};

async function mp(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}) {
  const r = await fetch(`${MP_API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.idempotencyKey ? { 'X-Idempotency-Key': init.idempotencyKey } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!r.ok) {
    const err: any = new Error(`Mercado Pago ${r.status}: ${data?.message ?? text.slice(0, 120)}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

export interface CheckoutInput {
  paymentId: string;
  title: string;
  amount: number;
  payerEmail?: string | null;
}

// Crea la preferencia de pago y regresa la liga para pagar.
export async function createCheckout(input: CheckoutInput): Promise<{ preferenceId: string; checkoutUrl: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + paymentsConfig.pendingMinutes * 60000);
  const base = paymentsConfig.publicUrl;
  const pref = await mp('/checkout/preferences', {
    method: 'POST',
    idempotencyKey: `pref-${input.paymentId}`,
    body: {
      items: [{ id: input.paymentId, title: input.title, quantity: 1, unit_price: input.amount, currency_id: 'MXN' }],
      external_reference: input.paymentId,
      ...(input.payerEmail ? { payer: { email: input.payerEmail } } : {}),
      ...(base
        ? {
            notification_url: `${base}/api/v1/pagos/webhook`,
            back_urls: { success: `${base}/pagos/retorno`, failure: `${base}/pagos/retorno`, pending: `${base}/pagos/retorno` },
            auto_return: 'approved',
          }
        : {}),
      expires: true,
      expiration_date_to: expiresAt.toISOString(),
      statement_descriptor: 'SIGVA PARQUIMETRO',
    },
  });
  return { preferenceId: pref.id, checkoutUrl: pref.init_point, expiresAt };
}

export interface ProviderPayment {
  id: string;
  status: string; // approved | rejected | cancelled | pending | in_process | refunded ...
  externalReference: string | null;
  amount: number;
  paymentType: string | null;
}

export async function fetchPayment(id: string): Promise<ProviderPayment> {
  const p = await mp(`/v1/payments/${encodeURIComponent(id)}`);
  return {
    id: String(p.id),
    status: String(p.status),
    externalReference: p.external_reference ?? null,
    amount: Number(p.transaction_amount),
    paymentType: p.payment_type_id ?? null,
  };
}

export async function refundPayment(id: string): Promise<void> {
  await mp(`/v1/payments/${encodeURIComponent(id)}/refunds`, { method: 'POST', body: {}, idempotencyKey: `refund-${id}` });
}

// Forma de pago de Mercado Pago → enum PaymentMethod
export function methodFrom(paymentType: string | null): 'CARD' | 'CASH' | 'WALLET' | 'QR' {
  switch (paymentType) {
    case 'credit_card':
    case 'debit_card':
    case 'prepaid_card':
      return 'CARD';
    case 'ticket':
    case 'atm':
      return 'CASH'; // OXXO / efectivo
    case 'bank_transfer':
      return 'QR'; // SPEI / CoDi
    default:
      return 'WALLET'; // dinero en cuenta de Mercado Pago
  }
}

// Verifica la firma x-signature de las notificaciones (si MP_WEBHOOK_SECRET está configurada).
// Formato: x-signature: "ts=1700000000,v1=<hmac>"; plantilla "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
export function verifyWebhookSignature(headers: Record<string, unknown>, dataId: string): boolean {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true; // sin clave: se confía en la consulta directa a la API de Mercado Pago
  const sig = String(headers['x-signature'] ?? '');
  const reqId = String(headers['x-request-id'] ?? '');
  const parts = Object.fromEntries(sig.split(',').map((kv) => kv.trim().split('=') as [string, string]));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${reqId};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(parts.v1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
