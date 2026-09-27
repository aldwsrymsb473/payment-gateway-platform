import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';

const app = express();
const port = Number(process.env.PORT || 3000);
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const currency = (process.env.DEFAULT_CURRENCY || 'sar').toLowerCase();
const stripe = process.env.STRIPE_SECRET_KEY?.startsWith('sk_')
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'rahati-payment-gateway', providerConfigured: Boolean(stripe) });
});

// Stripe requires the raw request body for signature verification.
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Webhook is not configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    return res.status(400).json({ error: `Invalid webhook signature: ${error.message}` });
  }

  // TODO: persist the event id idempotently, then update the booking state.
  switch (event.type) {
    case 'checkout.session.completed':
      console.log('Payment completed:', event.data.object.id);
      break;
    case 'checkout.session.expired':
      console.log('Checkout expired:', event.data.object.id);
      break;
    default:
      break;
  }
  return res.json({ received: true });
});

app.use(express.json({ limit: '100kb' }));

app.post('/api/payments/checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payment provider is not configured' });

  const { bookingId, amountHalalas, customerEmail } = req.body || {};
  if (!bookingId || !Number.isInteger(amountHalalas) || amountHalalas < 100) {
    return res.status(400).json({ error: 'bookingId and a valid amountHalalas are required' });
  }
  if (customerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) {
    return res.status(400).json({ error: 'Invalid customerEmail' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency,
      customer_email: customerEmail || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amountHalalas,
          product_data: { name: `حجز شقة - ${bookingId}` }
        }
      }],
      metadata: { bookingId },
      success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/payment/cancelled`
    });
    return res.status(201).json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Checkout creation failed:', error.message);
    return res.status(502).json({ error: 'Unable to create checkout session' });
  }
});

app.listen(port, () => console.log(`Payment service listening on ${baseUrl}`));
