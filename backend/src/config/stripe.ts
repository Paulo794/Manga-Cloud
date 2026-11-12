import Stripe from 'stripe';
import { HttpError } from '../http';
let instance: Stripe | undefined;
export function getStripe(): Stripe {
  if (process.env.STRIPE_DEMO_ENABLED !== 'true' || !process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new HttpError(503, 'BILLING_NOT_CONFIGURED', 'A demonstração de assinatura não está configurada.');
  return instance ??= new Stripe(process.env.STRIPE_SECRET_KEY, { timeout: 5000, maxNetworkRetries: 1 });
}
