// netlify/functions/stripe-webhook.js
// Stripe Webhook Handler für automatische Premium-Aktivierung

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

// Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Wichtig: Service Role Key verwenden!
);

exports.handler = async (event, context) => {
  console.log('🔔 Webhook received:', event.httpMethod);
  
  // Nur POST requests erlauben
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const sig = event.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  let stripeEvent;

  try {
    // Stripe Event verifizieren
    stripeEvent = stripe.webhooks.constructEvent(
      event.body, 
      sig, 
      endpointSecret
    );
    console.log('✅ Webhook signature verified');
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Webhook Error: ${err.message}` })
    };
  }

  console.log('📨 Event type:', stripeEvent.type);

  try {
    // Event basierend auf Typ verarbeiten
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
      body: JSON.stringify({ received: true, type: stripeEvent.type })
    };

  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

// Checkout erfolgreich abgeschlossen
async function handleCheckoutCompleted(session) {
  console.log('💳 Checkout completed for session:', session.id);
  
  const telegramUserId = parseInt(session.client_reference_id);
  if (!telegramUserId) {
    console.error('❌ No telegram user ID in session');
    return;
  }

  // Customer ID in User-Tabelle speichern
  await supabase
    .from('users')
    .update({ 
      stripe_customer_id: session.customer 
    })
    .eq('id', telegramUserId);

  console.log(`✅ Updated customer ID for user ${telegramUserId}`);
}

// Subscription erstellt/aktualisiert
async function handleSubscriptionUpdated(subscription) {
  console.log('📅 Subscription updated:', subscription.id);
  
  const customerId = subscription.customer;
  
  // User anhand Customer ID finden
  const { data: users, error } = await supabase
    .from('users')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (error || !users) {
    console.error('❌ User not found for customer:', customerId);
    return;
  }

  const userId = users.id;
  
  // Premium-Status aktivieren
  const expiresAt = new Date(subscription.current_period_end * 1000).toISOString();
  
  const { error: updateError } = await supabase
    .from('users')
    .update({
      premium_active: true,
      premium_expires_at: expiresAt,
      stripe_subscription_id: subscription.id
    })
    .eq('id', userId);

  if (updateError) {
    console.error('❌ Error updating user premium status:', updateError);
    return;
  }

  console.log(`✅ Premium activated for user ${userId} until ${expiresAt}`);
  
  // Payment-Eintrag erstellen
  await createPaymentRecord(userId, subscription);
}

// Subscription gelöscht/gekündigt
async function handleSubscriptionDeleted(subscription) {
  console.log('🗑️ Subscription deleted:', subscription.id);
  
  const customerId = subscription.customer;
  
  // User finden und Premium deaktivieren
  const { data: users } = await supabase
    .from('users')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (!users) {
    console.error('❌ User not found for customer:', customerId);
    return;
  }

  const { error } = await supabase
    .from('users')
    .update({
      premium_active: false,
      stripe_subscription_id: null
    })
    .eq('id', users.id);

  if (!error) {
    console.log(`✅ Premium deactivated for user ${users.id}`);
  }
}

// Zahlung erfolgreich
async function handlePaymentSucceeded(invoice) {
  console.log('💰 Payment succeeded for invoice:', invoice.id);
  
  const customerId = invoice.customer;
  
  // User finden
  const { data: users } = await supabase
    .from('users')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (!users) {
    console.error('❌ User not found for customer:', customerId);
    return;
  }

  // Premium verlängern falls Subscription vorhanden
  if (invoice.subscription) {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const expiresAt = new Date(subscription.current_period_end * 1000).toISOString();
    
    await supabase
      .from('users')
      .update({
        premium_active: true,
        premium_expires_at: expiresAt
      })
      .eq('id', users.id);

    console.log(`✅ Premium extended for user ${users.id} until ${expiresAt}`);
  }

  // Payment-Eintrag erstellen
  await createPaymentRecord(users.id, invoice, 'succeeded');
}

// Zahlung fehlgeschlagen
async function handlePaymentFailed(invoice) {
  console.log('❌ Payment failed for invoice:', invoice.id);
  
  const customerId = invoice.customer;
  
  // User finden
  const { data: users } = await supabase
    .from('users')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single();

  if (!users) {
    console.error('❌ User not found for customer:', customerId);
    return;
  }

  // Payment-Eintrag erstellen
  await createPaymentRecord(users.id, invoice, 'failed');
  
  // Optional: Grace period oder sofortiges Deaktivieren
  console.log(`⚠️ Payment failed for user ${users.id} - consider grace period`);
}

// Payment-Eintrag in Datenbank erstellen
async function createPaymentRecord(userId, stripeObject, status = 'succeeded') {
  let amount, currency, paymentType;
  
  if (stripeObject.object === 'subscription') {
    const priceId = stripeObject.items.data[0].price.id;
    amount = stripeObject.items.data[0].price.unit_amount;
    currency = stripeObject.items.data[0].price.currency;
    
    // Payment type basierend auf Intervall bestimmen
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
      payment_type: paymentType
    });

  if (error) {
    console.error('❌ Error creating payment record:', error);
  } else {
    console.log(`✅ Payment record created for user ${userId}`);
  }
}