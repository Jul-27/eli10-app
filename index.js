const express = require('express');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const axios = require('axios');
const FormData = require('form-data');

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});
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

// Dokument hochladen und analysieren
app.post('/upload-document', upload.single('document'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Kein Dokument hochgeladen' });
  }

  try {
    let text = '';

    // PDF verarbeiten
    if (req.file.mimetype === 'application/pdf') {
      const pdfData = await pdfParse(req.file.buffer);
      text = pdfData.text;
    }

    if (!text || text.trim().length < 10) {
      return res.status(400).json({ error: 'Kein Text im Dokument gefunden' });
    }

    // Text auf 8000 Zeichen begrenzen
    // Doppelte Leerzeilen entfernen und Text kürzen
    const cleanText = text.replace(/\s+/g, ' ').trim();
    const truncatedText = cleanText.substring(0, 4000);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `Du bist ELI10, ein Assistent der komplexe Texte so erklärt, dass jeder sie versteht — auch ohne Vorwissen.
Erkenne automatisch die Sprache des Textes und antworte in derselben Sprache.

WICHTIGE REGELN:
- Erkläre JEDEN Fachbegriff sofort in Klammern, z.B.: "Effektivzinssatz (= der echte Gesamtzinssatz pro Jahr, inkl. aller Kosten)"
- Hebe wichtige Zahlen, Beträge und Fristen mit **fett** hervor
- Schreibe kurze, klare Sätze — maximal 2 Zeilen pro Punkt

Strukturiere deine Antwort IMMER exakt so mit Markdown:

## 📋 Worum geht es?
2-3 einfache Sätze die den Kern des Dokuments erklären.

## 🔍 Die wichtigsten Punkte
- Erkläre jeden Punkt einzeln, mit Fachbegriff-Erklärungen in Klammern
- Hebe wichtige Zahlen und Beträge **fett** hervor

## ⚠️ Risiken & Fristen
Nur wenn vorhanden:
- Fristen mit konkretem Datum oder Zeitraum **fett** markieren
- Risiken klar und verständlich erklären

## ✅ Was muss ich tun?
- Konkrete, nummerierte Handlungsschritte

## 💡 Zusammenfassung
Ein einziger, klarer Satz der alles zusammenfasst.`
        },
        {
          role: 'user',
          content: `Bitte erkläre mir dieses Dokument einfach und fasse es kurz zusammen. Maximal 300 Wörter:\n\n${truncatedText}`
        }
      ]
    });

    const explanation = completion.choices[0].message.content;
    res.json({ explanation });

  } catch (error) {
    console.error('Upload Fehler:', error.message);
    res.status(500).json({ error: 'Dokument konnte nicht verarbeitet werden.' });
  }
});

app.post('/check-status', async (req, res) => {
  const { user_id } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const FREE_LIMIT = 5;

  try {
    const { data: sessionData } = await supabase.auth.admin.getUserById(user_id);
    const userEmail = sessionData?.user?.email;

    const { data: userData, error } = await supabase
      .from('users')
      .select('plan, created_at')
      .eq('email', userEmail)
      .single();

    // Kein Eintrag gefunden = Free User
    const isPremium = !error && userData?.plan === 'premium';

    if (isPremium) {
      return res.json({ remaining: 999, isPremium: true, premiumSince: userData.created_at });
    }

    const { data: usageData } = await supabase
      .from('usage')
      .select('count')
      .eq('user_id', user_id)
      .eq('date', today)
      .single();

    const remaining = FREE_LIMIT - (usageData?.count || 0);
    res.json({ remaining, isPremium: false, premiumSince: null });

  } catch (err) {
    console.error('check-status Fehler:', err.message);
    res.json({ remaining: 5, isPremium: false, premiumSince: null });
  }
});

// Foto analysieren (OCR)
app.post('/analyze-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Kein Bild hochgeladen' });
  }

  try {
    // OCR.space API aufrufen
    const formData = new FormData();
    formData.append('base64Image', `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`);
    formData.append('language', 'ger');
    formData.append('isOverlayRequired', 'false');
    formData.append('apikey', process.env.OCR_SPACE_API_KEY);

    const ocrResponse = await axios.post(
      'https://api.ocr.space/parse/image',
      formData,
      { headers: formData.getHeaders() }
    );

    const text = ocrResponse.data.ParsedResults?.[0]?.ParsedText;

    if (!text || text.trim().length < 10) {
      return res.status(400).json({ error: 'Kein Text im Bild gefunden. Bitte ein klareres Foto machen.' });
    }

    const cleanText = text.replace(/\s+/g, ' ').trim();
    const truncatedText = cleanText.substring(0, 4000);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `Du bist ELI10, ein Assistent der komplexe Texte so erklärt, dass jeder sie versteht — auch ohne Vorwissen.
Erkenne automatisch die Sprache des Textes und antworte in derselben Sprache.

WICHTIGE REGELN:
- Erkläre JEDEN Fachbegriff sofort in Klammern, z.B.: "Effektivzinssatz (= der echte Gesamtzinssatz pro Jahr, inkl. aller Kosten)"
- Hebe wichtige Zahlen, Beträge und Fristen mit **fett** hervor
- Schreibe kurze, klare Sätze — maximal 2 Zeilen pro Punkt

Strukturiere deine Antwort IMMER exakt so mit Markdown:

## 📋 Worum geht es?
2-3 einfache Sätze die den Kern des Dokuments erklären.

## 🔍 Die wichtigsten Punkte
- Erkläre jeden Punkt einzeln, mit Fachbegriff-Erklärungen in Klammern
- Hebe wichtige Zahlen und Beträge **fett** hervor

## ⚠️ Risiken & Fristen
Nur wenn vorhanden:
- Fristen mit konkretem Datum oder Zeitraum **fett** markieren
- Risiken klar und verständlich erklären

## ✅ Was muss ich tun?
- Konkrete, nummerierte Handlungsschritte

## 💡 Zusammenfassung
Ein einziger, klarer Satz der alles zusammenfasst.`
        },
        {
          role: 'user',
          content: `Bitte erkläre mir diesen Text aus einem Foto einfach und fasse ihn kurz zusammen. Maximal 300 Wörter:\n\n${truncatedText}`
        }
      ]
    });

    const explanation = completion.choices[0].message.content;
    res.json({ explanation });

  } catch (error) {
    console.error('OCR Fehler:', error.message);
    res.status(500).json({ error: 'Bild konnte nicht verarbeitet werden.' });
  }
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
  const { data: sessionData } = await supabase.auth.admin.getUserById(user_id);
const userEmail = sessionData?.user?.email;

const { data: userData } = await supabase
    .from('users')
    .select('plan')
    .eq('email', userEmail)
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
          content: `Du bist ELI10, ein Assistent der komplexe Texte so erklärt, dass jeder sie versteht — auch ohne Vorwissen.
Erkenne automatisch die Sprache des Textes und antworte in derselben Sprache.

WICHTIGE REGELN:
- Erkläre JEDEN Fachbegriff sofort in Klammern, z.B.: "Effektivzinssatz (= der echte Gesamtzinssatz pro Jahr, inkl. aller Kosten)"
- Hebe wichtige Zahlen, Beträge und Fristen mit **fett** hervor
- Schreibe kurze, klare Sätze — maximal 2 Zeilen pro Punkt

Strukturiere deine Antwort IMMER exakt so mit Markdown:

## 📋 Worum geht es?
2-3 einfache Sätze die den Kern des Dokuments erklären.

## 🔍 Die wichtigsten Punkte
- Erkläre jeden Punkt einzeln, mit Fachbegriff-Erklärungen in Klammern
- Hebe wichtige Zahlen und Beträge **fett** hervor

## ⚠️ Risiken & Fristen
Nur wenn vorhanden:
- Fristen mit konkretem Datum oder Zeitraum **fett** markieren
- Risiken klar und verständlich erklären

## ✅ Was muss ich tun?
- Konkrete, nummerierte Handlungsschritte

## 💡 Zusammenfassung
Ein einziger, klarer Satz der alles zusammenfasst.`
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

// Erklärung in History speichern
await supabase
  .from('history')
  .insert({
    user_id,
    input_text: text.substring(0, 500),
    explanation: explanation.substring(0, 2000),
    created_at: new Date().toISOString()
  });

    res.json({ explanation, remaining });

  } catch (error) {
    console.error('Groq Fehler:', error.message);
    res.status(500).json({ error: 'KI konnte den Text nicht verarbeiten.' });
  }
});

// Verlauf abrufen
app.get('/history/:user_id', async (req, res) => {
  const { user_id } = req.params;

  const { data, error } = await supabase
    .from('history')
    .select('*')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    return res.status(500).json({ error: 'Verlauf konnte nicht geladen werden.' });
  }

  res.json({ history: data });
});

app.listen(3000, () => {
  console.log('ELI10 läuft auf Port 3000');
});

module.exports = app;
