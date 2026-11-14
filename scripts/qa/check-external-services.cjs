// Somente leitura: consulta o preço Stripe configurado e verifica SMTP; não envia email.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const backend = createRequire(path.join(root, 'backend/package.json'));
const auth = createRequire(path.join(root, 'auth-service/package.json'));
backend('dotenv').config({ path: path.join(root, '.env'), quiet: true });
backend('tsx/cjs');

async function checkStripe() {
  const key = process.env.STRIPE_SECRET_KEY || '', priceId = process.env.STRIPE_PRICE_ID || '';
  if (!key.startsWith('sk_test_') || !priceId.startsWith('price_')) return { status: 'pending', reason: 'Chave de teste ou preço não configurado.' };
  try {
    const Stripe = backend('stripe');
    const stripe = new Stripe(key, { timeout: 8000, maxNetworkRetries: 0 });
    const price = await stripe.prices.retrieve(priceId);
    if (price.livemode) return { status: 'failed', reason: 'O preço não está no modo de teste.' };
    return { status: price.active && price.recurring ? 'ok' : 'pending', testMode: true, active: price.active, currency: price.currency, unitAmount: price.unit_amount, interval: price.recurring?.interval || null, intervalCount: price.recurring?.interval_count || null, demoEnabled: process.env.STRIPE_DEMO_ENABLED === 'true', checkoutCreated: false, webhookVerified: false };
  } catch (error) { return { status: 'failed', type: error.type || error.name || 'Error', code: error.code || null, httpStatus: error.statusCode || null }; }
}
async function checkSmtp() {
  if (!process.env.MAILTRAP_HOST) return { status: 'pending', reason: 'SMTP não configurado.' };
  let transport;
  try {
    transport = auth('./src/utils/mail.ts').createResetEmailTransport();
    await transport.verify();
    return { status: 'ok', authenticationVerified: !!process.env.MAILTRAP_USER, senderExplicitlyConfigured: !!process.env.MAIL_FROM, emailSent: false, deliveryVerified: false };
  } catch (error) { return { status: 'failed', code: error.code || null, name: error.name || 'Error', responseCode: error.responseCode || null, emailSent: false }; }
  finally { transport?.close(); }
}
(async () => {
  const [stripe, smtp] = await Promise.all([checkStripe(), checkSmtp()]);
  const report = { checkedAt: new Date().toISOString(), mode: 'read-only', stripe, smtp };
  const folder = path.join(root, 'docs/qa/evidencias'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'external-services-check.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (stripe.status !== 'ok' || smtp.status !== 'ok') process.exitCode = 1;
})().catch(() => { console.error('Falha na verificação externa; revisar configuração.'); process.exitCode = 1; });
