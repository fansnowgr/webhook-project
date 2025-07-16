const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Wichtig: Service Role Key verwenden!
);

exports.handler = async (event, context) => {
  console.log('🔔 Webhook received:', event.httpMethod);
  
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const sig = event.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, endpointSecret);
    console.log('✅ Webhook signature verified');
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Webhook Error: ${err.message}` }),
    };
  }

  console.log('📨 Event type:', stripeEvent.type);

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripeEvent.data.object);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(stripeEvent.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripeEvent.data.object);
        break;

      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(stripeEvent.data.object);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(stripeEvent.data.object);
        break;

      default:
        console.log(`🤷‍♂️ Unhandled event type: ${stripeEvent.type}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true, type: stripeEvent.type }),
    };
  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

// --- Handler-Funktionen ---

async function handleCheckoutCompleted(session) {
  console.log('💳 Checkout completed for session:', session.id);

  const telegramUserId = parseInt(session.client_reference_id);
  if (!telegramUserId) {
    console.error('❌ No telegram user ID in session');
    return;
  }

  // Stripe Customer ID im User speichern
  const { error } = await supabase
    .from('users')
    .update({ stripe_customer_id: session.customer })
    .eq('id', telegramUserId);

  if (error) {
    console.error('❌ Error updating stripe_customer_id:', error);
  } else {
    console.log(`✅ Updated customer ID for user ${telegramUserId}`);
  }
}

async function handleSubscriptionUpdated(subscription) {
  console.log('📅 Subscription updated:', subscription.id);

  const customerId = subscription.customer;

  const { data: user, error } = await supabase
    .from('users')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (error || !user) {
    console.error('❌ User not found for customer:', customerId);
    return;
  }

  const expiresAt = new Date(subscription.current_period_end * 1000).toISOString();

  const { error: updateError } = await supabase
    .from('users')
    .update({
      premium_active: true,
      premium_expires_at: expiresAt,
      stripe_subscription_id: subscription.id,
    })
    .eq('id', user.id);

  if (updateError) {
    console.error('❌ Error updating premium status:', updateError);
    return;
  }

  console.log(`✅ Premium activated for user ${user.id} until ${expiresAt}`);

  await createPaymentRecord(user.id, subscription);
}

async function handleSubscriptionDeleted(subscription) {
  console.log('🗑️ Subscription deleted:', subscription.id);

  const customerId = subscription.customer;

  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (!user) {
    console.error('❌ User not found for customer:', customerId);
    return;
  }

  const { error } = await supabase
    .from('users')
    .update({
      premium_active: false,
      stripe_subscription_id: null,
    })
    .eq('id', user.id);

  if (!error) {
    console.log(`✅ Premium deactivated for user ${user.id}`);
  }
}

async function handlePaymentSucceeded(invoice) {
  console.log('💰 Payment succeeded for invoice:', invoice.id);

  const customerId = invoice.customer;

  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (!user) {
    console.error('❌ User not found for customer:', customerId);
    return;
  }

  if (invoice.subscription) {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const expiresAt = new Date(subscription.current_period_end * 1000).toISOString();

    await supabase
      .from('users')
      .update({
        premium_active: true,
        premium_expires_at: expiresAt,
      })
      .eq('id', user.id);

    console.log(`✅ Premium extended for user ${user.id} until ${expiresAt}`);
  }

  await createPaymentRecord(user.id, invoice, 'succeeded');
}

async function handlePaymentFailed(invoice) {
  console.log('❌ Payment failed for invoice:', invoice.id);

  const customerId = invoice.customer;

  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (!user) {
    console.error('❌ User not found for customer:', customerId);
    return;
  }

  await createPaymentRecord(user.id, invoice, 'failed');

  console.log(`⚠️ Payment failed for user ${user.id} - consider grace period`);
}

async function createPaymentRecord(userId, stripeObject, status = 'succeeded') {
  let amount, currency, paymentType;

  if (stripeObject.object === 'subscription') {
    amount = stripeObject.items.data[0].price.unit_amount;
    currency = stripeObject.items.data[0].price.currency;
    const interval = stripeObject.items.data[0].price.recurring.interval;
    paymentType = interval === 'year' ? 'yearly' : 'monthly';
  } else if (stripeObject.object === 'invoice') {
    amount = stripeObject.amount_paid;
    currency = stripeObject.currency;
    paymentType = stripeObject.billing_reason === 'subscription_create' ? 'monthly' : 'renewal';
  }

  const { error } = await supabase
    .from('payments')
    .insert({
      user_id: userId,
      stripe_payment_intent_id: stripeObject.payment_intent || stripeObject.id,
      amount: amount,
      currency: currency.toUpperCase(),
      status: status,
      payment_type: paymentType,
    });

  if (error) {
    console.error('❌ Error creating payment record:', error);
  } else {
    console.log(`✅ Payment record created for user ${userId}`);
  }
}
