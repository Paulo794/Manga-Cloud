import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { getStripe } from '../config/stripe';
import { makeAuthenticate, AuthRequest } from '../middleware/authMiddleware';
import { HttpError } from '../http';
import { audit } from '../audit/auditClient';
import crypto from 'crypto';
import { currentSubscription } from '../services/library';

const metadataFor = (user: RowDataPacket) => ({ app: 'mangacloud', userId: String(user.id), billingIdentity: String(user.billing_identity) });
function ownsSubscription(subscription: Stripe.Subscription, user: RowDataPacket) {
  const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  return subscription.livemode === false && !!user.billing_identity && customer === user.stripe_customer_id &&
    subscription.metadata?.app === 'mangacloud' && subscription.metadata?.userId === String(user.id) && subscription.metadata?.billingIdentity === user.billing_identity;
}
const billingError = (error: unknown) => error instanceof HttpError ? error : new HttpError(503, 'BILLING_UNAVAILABLE', 'A assinatura está temporariamente indisponível. Tente novamente.');

function appBase() {
  let base: URL;
  try { base = new URL(process.env.APP_URL || ''); } catch { throw new HttpError(503, 'BILLING_NOT_CONFIGURED', 'Endereço da assinatura não configurado.'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new HttpError(503, 'BILLING_NOT_CONFIGURED', 'Endereço da assinatura inválido.');
  return base.href.replace(/\/$/, '');
}

export function billingRouter(db: Pool, clientFactory = getStripe, emit: typeof audit = audit) {
  const router = Router();
  router.post('/checkout', makeAuthenticate(db), async (req: AuthRequest, res) => {
    const stripe = clientFactory(), price = process.env.STRIPE_PRICE_ID, base = appBase();
    if (!price || !base) throw new HttpError(503, 'BILLING_NOT_CONFIGURED', 'Preço ou endereço da assinatura não configurados.');
    try {
      const configuredPrice = await stripe.prices.retrieve(price);
      if (configuredPrice.livemode || !configuredPrice.active || configuredPrice.currency !== 'brl' || configuredPrice.unit_amount !== 990 || configuredPrice.recurring?.interval !== 'month' || configuredPrice.recurring.interval_count !== 1) throw new HttpError(503, 'BILLING_PRICE_INVALID', 'O preço de teste deve ser R$ 9,90 por mês.');
    } catch (error) { throw billingError(error); }
    // Commit próprio antes da chamada externa: a identidade sobrevive a rollback
    // após criar cliente no Stripe, e é diferente em bancos que reutilizam IDs.
    await db.query('UPDATE usuarios SET billing_identity=COALESCE(billing_identity, ?) WHERE id=?', [crypto.randomUUID(), req.user!.id]);
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [users] = await conn.query<RowDataPacket[]>('SELECT id, email, stripe_customer_id, billing_identity FROM usuarios WHERE id=? FOR UPDATE', [req.user!.id]);
      const user = users[0]!;
      const [subscriptions] = await conn.query<RowDataPacket[]>("SELECT id FROM assinaturas WHERE usuario_id=? AND status='active' AND acesso_ate > UTC_TIMESTAMP()", [user.id]);
      if (subscriptions.length) throw new HttpError(409, 'ALREADY_SUBSCRIBED', 'Sua assinatura já está ativa.');
      let customer: string = user.stripe_customer_id;
      if (!customer) {
        const created = await stripe.customers.create({ email: user.email, metadata: metadataFor(user) }, { idempotencyKey: `mangacloud-customer-${user.billing_identity}` });
        customer = created.id;
        await conn.query('UPDATE usuarios SET stripe_customer_id=? WHERE id=?', [customer, user.id]);
      } else {
        const existing = await stripe.customers.retrieve(customer);
        if (existing.deleted || existing.livemode || existing.metadata?.billingIdentity !== user.billing_identity || existing.metadata?.app !== 'mangacloud' || existing.metadata?.userId !== String(user.id)) throw new HttpError(409, 'BILLING_ACCOUNT_MISMATCH', 'Não foi possível confirmar o vínculo da conta de cobrança.');
      }
      const existingSubs = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
      if (existingSubs.data.some(s => !['canceled', 'incomplete_expired'].includes(s.status))) throw new HttpError(409, 'SUBSCRIPTION_EXISTS', 'Já existe uma assinatura em processamento para sua conta.');
      const history = await stripe.checkout.sessions.list({ customer, limit: 100 });
      if (existingSubs.has_more || history.has_more) throw new HttpError(409, 'BILLING_REVIEW_REQUIRED', 'A conta de cobrança precisa de revisão antes de uma nova assinatura.');
      const successUrl = `${base}/sucesso`, cancelUrl = `${base}/assinatura`;
      const ownOpen = history.data.filter(s => s.status === 'open' && s.metadata?.app === 'mangacloud' && s.metadata?.billingIdentity === user.billing_identity);
      let session = ownOpen.find(s => s.metadata?.priceId === price && s.success_url === successUrl && s.cancel_url === cancelUrl);
      for (const obsolete of ownOpen.filter(s => s !== session)) await stripe.checkout.sessions.expire(obsolete.id);
      if (!session) session = await stripe.checkout.sessions.create({ mode: 'subscription', customer,
        line_items: [{ price, quantity: 1 }], success_url: successUrl, cancel_url: cancelUrl,
        metadata: { ...metadataFor(user), priceId: price }, subscription_data: { metadata: metadataFor(user) }
      }, { idempotencyKey: `mangacloud-checkout-${crypto.createHash('sha256').update(JSON.stringify([user.billing_identity, customer, price, base, history.data[0]?.id ?? 'initial'])).digest('hex')}` });
      if (session.livemode || !session.url) throw new HttpError(503, 'BILLING_UNAVAILABLE', 'O checkout de teste não está disponível.');
      await conn.commit();
      res.json({ url: session.url });
    } catch (error) { await conn.rollback(); throw billingError(error); }
    finally { conn.release(); }
  });
  for (const [route, cancel] of [['/cancelar', true], ['/reativar', false]] as const) {
    router.post(route, makeAuthenticate(db), async (req: AuthRequest, res) => {
      const stripe = clientFactory(), conn = await db.getConnection();
      try {
        await conn.beginTransaction();
        const [users] = await conn.query<RowDataPacket[]>('SELECT id, stripe_customer_id, billing_identity FROM usuarios WHERE id=? FOR UPDATE', [req.user!.id]);
        const [rows] = await conn.query<RowDataPacket[]>('SELECT stripe_subscription_id FROM assinaturas WHERE usuario_id=?', [req.user!.id]);
        if (!rows[0]) throw new HttpError(404, 'SUBSCRIPTION_NOT_FOUND', 'Sua conta não possui assinatura para gerenciar.');
        const subscription = await stripe.subscriptions.retrieve(rows[0].stripe_subscription_id);
        if (!users[0] || !ownsSubscription(subscription, users[0])) throw new HttpError(409, 'BILLING_ACCOUNT_MISMATCH', 'Não foi possível confirmar o vínculo da assinatura.');
        if (!['active', 'past_due'].includes(subscription.status) || (!cancel && subscription.status !== 'active')) throw new HttpError(409, 'SUBSCRIPTION_NOT_MANAGEABLE', 'Esta assinatura não permite alterar a renovação.');
        if (subscription.cancel_at_period_end !== cancel) {
          const updated = await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: cancel }, { idempotencyKey: `mangacloud-renewal-${crypto.randomUUID()}` });
          if (!ownsSubscription(updated, users[0]) || updated.cancel_at_period_end !== cancel) throw new HttpError(503, 'BILLING_UNAVAILABLE', 'O Stripe ainda não confirmou a mudança.');
        }
        // Confirma apenas a renovação. A concessão de Pro continua dependendo
        // de pagamento confirmado pelo webhook, nunca desta ação do cliente.
        await conn.query('UPDATE assinaturas SET cancel_at_period_end=? WHERE usuario_id=? AND stripe_subscription_id=?', [cancel ? 1 : 0, req.user!.id, subscription.id]);
        await conn.commit();
        emit({ usuario_id: req.user!.id, acao: cancel ? 'assinatura.renovacao_cancelada' : 'assinatura.renovacao_reativada', resultado: 'sucesso', recurso: `assinatura:${subscription.id}` });
        res.json(await currentSubscription(db, req.user!.id));
      } catch (error) { await conn.rollback(); throw billingError(error); }
      finally { conn.release(); }
    });
  }
  return router;
}

export function stripeWebhook(db: Pool, emit: typeof audit = audit, clientFactory = getStripe) {
  return async (req: Request, res: Response) => {
    const stripe = clientFactory(), signature = req.headers['stripe-signature'], secret = process.env.STRIPE_WEBHOOK_SECRET;
    let event: Stripe.Event;
    try {
      if (typeof signature !== 'string' || !secret || !Buffer.isBuffer(req.body)) throw new Error('Invalid signature');
      event = stripe.webhooks.constructEvent(req.body, signature, secret);
      if (event.livemode) throw new Error('Only test events allowed');
    } catch { throw new HttpError(400, 'INVALID_WEBHOOK', 'Webhook inválido.'); }
    const object = event.data.object as any;
    const relevant = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed'];
    if (!relevant.includes(event.type)) { res.json({ received: true, ignored: true }); return; }
    const subscriptionId = event.type.startsWith('customer.subscription.') ? object.id : object.subscription ?? object.parent?.subscription_details?.subscription;
    const subscriptionKey = typeof subscriptionId === 'string' ? subscriptionId : subscriptionId?.id;
    if (!subscriptionKey) { res.json({ received: true, ignored: true }); return; }
    const [prior] = await db.query<RowDataPacket[]>("SELECT event_id FROM stripe_eventos WHERE event_id=? AND status='processed'", [event.id]);
    if (prior.length) { res.json({ received: true }); return; }
    const initial = await stripe.subscriptions.retrieve(subscriptionKey, { expand: ['latest_invoice'] });
    const userId = Number(initial.metadata?.userId);
    if (initial.metadata?.app !== 'mangacloud' || !Number.isSafeInteger(userId) || userId <= 0) { res.json({ received: true, ignored: true }); return; }
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("INSERT INTO stripe_eventos (event_id, tipo, stripe_created_ts, status) VALUES (?, ?, ?, 'processing') ON DUPLICATE KEY UPDATE event_id=VALUES(event_id)", [event.id, event.type, event.created]);
      const [processed] = await conn.query<RowDataPacket[]>('SELECT status FROM stripe_eventos WHERE event_id=? FOR UPDATE', [event.id]);
      if (processed[0]?.status === 'processed') { await conn.commit(); res.json({ received: true }); return; }
      const [users] = await conn.query<RowDataPacket[]>('SELECT id, stripe_customer_id, billing_identity FROM usuarios WHERE id=? FOR UPDATE', [userId]);
      // Estado atual após serialização por usuário: não confiar em timestamp, inclusive empates.
      const latest = await stripe.subscriptions.retrieve(subscriptionKey, { expand: ['latest_invoice'] });
      const customer = typeof latest.customer === 'string' ? latest.customer : latest.customer.id;
      if (!users[0] || !ownsSubscription(latest, users[0])) {
        await conn.query("UPDATE stripe_eventos SET status='processed', processado_em=UTC_TIMESTAMP() WHERE event_id=?", [event.id]);
        await conn.commit(); res.json({ received: true, ignored: true }); return;
      }
      const [current] = await conn.query<RowDataPacket[]>('SELECT stripe_subscription_id, status FROM assinaturas WHERE usuario_id=?', [userId]);
      if (current[0] && current[0].stripe_subscription_id !== latest.id) {
        const other = await stripe.subscriptions.retrieve(current[0].stripe_subscription_id);
        if (!['canceled', 'incomplete_expired'].includes(other.status)) throw new Error('Subscription mismatch');
        if (['canceled', 'incomplete_expired'].includes(latest.status)) {
          await conn.query("UPDATE stripe_eventos SET status='processed', processado_em=UTC_TIMESTAMP() WHERE event_id=?", [event.id]);
          await conn.commit(); res.json({ received: true }); return;
        }
      }
      const item = latest.items.data[0], invoice = typeof latest.latest_invoice === 'object' ? latest.latest_invoice : null;
      const paid = latest.status === 'active' && invoice?.status === 'paid' && item?.price.id === process.env.STRIPE_PRICE_ID;
      const end = item?.current_period_end, until = paid && end ? new Date(end * 1000) : null;
      await conn.query(`INSERT INTO assinaturas (usuario_id, stripe_customer_id, stripe_subscription_id, price_id, status, acesso_ate, cancel_at_period_end, ultimo_evento_stripe_ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE stripe_customer_id=VALUES(stripe_customer_id), stripe_subscription_id=VALUES(stripe_subscription_id), price_id=VALUES(price_id), status=VALUES(status), acesso_ate=VALUES(acesso_ate), cancel_at_period_end=VALUES(cancel_at_period_end), ultimo_evento_stripe_ts=GREATEST(COALESCE(ultimo_evento_stripe_ts,0), VALUES(ultimo_evento_stripe_ts))`,
      [userId, customer, latest.id, item?.price.id ?? '', latest.status, until, latest.cancel_at_period_end ? 1 : 0, event.created]);
      await conn.query('UPDATE usuarios SET stripe_customer_id=?, is_premium=? WHERE id=?', [customer, until && until.getTime() > Date.now() ? 1 : 0, userId]);
      await conn.query("UPDATE stripe_eventos SET status='processed', erro_mensagem=NULL, processado_em=UTC_TIMESTAMP() WHERE event_id=?", [event.id]);
      await conn.commit();
      emit({ usuario_id: userId, acao: 'assinatura.atualizada', resultado: 'sucesso', recurso: `assinatura:${latest.id}` });
      res.json({ received: true });
    } catch {
      await conn.rollback();
      try { await db.query("INSERT INTO stripe_eventos (event_id, tipo, status, erro_mensagem) VALUES (?, ?, 'failed', 'Processamento pendente de repetição') ON DUPLICATE KEY UPDATE status=IF(status='processed','processed','failed')", [event.id, event.type]); } catch { /* Reenvio pelo status 500. */ }
      throw new HttpError(500, 'WEBHOOK_PROCESSING_FAILED', 'Webhook não aplicado; repetir processamento.');
    } finally { conn.release(); }
  };
}
