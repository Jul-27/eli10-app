const express = require('express');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Webhook braucht raw body — muss VOR express.json() stehen
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  res.send(fs.readFileSync(htmlPath, 'utf8'));
});

// Stripe Webhook
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook Fehler:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Subscription erstellt — Premium aktivieren
  if (event.type === 'customer.subscription.created') {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    const customer = await stripe.customers.retrieve(customerId);
    const email = customer.email;

    await supabase
      .from('users')
      .upsert({ id: customerId, email, plan: 'premium' });

    console.log(`Premium aktiviert für: ${email}`);
  }

  // Subscription gekündigt — zurück zu Free
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    await supabase
      .from('users')
      .update({ plan: 'free' })
      .eq('id', customerId);

    console.log(`Premium deaktiviert für customer: ${customerId}`);
  }

  res.json({ received: true });
});

// Checkout Session erstellen
app.post('/create-checkout', async (req, res) => {
  const { user_id, email } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1,
      }],
      success_url: `${process.env.APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_URL}/`,
      metadata: { user_id }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe Fehler:', error.message);
    res.status(500).json({ error: 'Checkout konnte nicht erstellt werden.' });
  }
});

// Nach erfolgreichem Kauf
app.get('/success', async (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'success.html');
  res.send(fs.readFileSync(htmlPath, 'utf8'));
});

app.post('/explain', async (req, res) => {
  const { text, user_id } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Kein Text angegeben' });
  }

  const today = new Date().toISOString().split('T')[0];
  const FREE_LIMIT = 5;

  // Prüfen ob Premium
  const { data: userData } = await supabase
    .from('users')
    .select('plan')
    .eq('id', user_id)
    .single();

  const isPremium = userData?.plan === 'premium';

  if (!isPremium) {
    const { data: usageData } = await supabase
      .from('usage')
      .select('count')
      .eq('user_id', user_id)
      .eq('date', today)
      .single();

    const currentCount = usageData?.count || 0;

    if (currentCount >= FREE_LIMIT) {
      return res.status(429).json({
        error: 'limit_reached',
        message: 'Du hast dein tägliches Limit von 5 Erklärungen erreicht. Upgrade auf Premium für unlimitierte Nutzung!'
      });
    }

    if (usageData) {
      await supabase
        .from('usage')
        .update({ count: currentCount + 1 })
        .eq('user_id', user_id)
        .eq('date', today);
    } else {
      await supabase
        .from('usage')
        .insert({ user_id, date: today, count: 1 });
    }
  }

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `Du bist ELI10, ein freundlicher Assistent der komplexe 
Texte so einfach erklärt, dass ein 10-jähriges Kind sie versteht.

Deine Regeln:
- Benutze kurze, einfache Sätze
- Erkläre Fachbegriffe sofort wenn du sie verwendest
- Nutze gerne Alltagsbeispiele
- Strukturiere die Erklärung klar mit Absätzen
- Weise auf wichtige Risiken oder Fristen hin
- Am Ende: eine kurze Zusammenfassung in 1-2 Sätzen`
        },
        {
          role: 'user',
          content: `Bitte erkläre mir diesen Text einfach:\n\n${text}`
        }
      ]
    });

    const explanation = completion.choices[0].message.content;

    const { data: usageData } = await supabase
      .from('usage')
      .select('count')
      .eq('user_id', user_id)
      .eq('date', today)
      .single();

    const remaining = isPremium ? 999 : FREE_LIMIT - (usageData?.count || 0);

    res.json({ explanation, remaining });

  } catch (error) {
    console.error('Groq Fehler:', error.message);
    res.status(500).json({ error: 'KI konnte den Text nicht verarbeiten.' });
  }
});

app.listen(3000, () => {
  console.log('ELI10 läuft auf Port 3000');
});

module.exports = app;
