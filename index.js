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
          content: `Du bist ELI10, ein Assistent der komplexe Texte so erklärt, dass ein Mensch ohne Fachkenntnisse sie vollständig versteht.
Erkenne automatisch die Sprache des Textes und antworte in derselben Sprache.

PFLICHTREGELN — halte dich IMMER daran:
- Erkläre zuerst die Grundidee des Dokuments (Was ist dieses Dokument? Worum geht es grundsätzlich?)
- Erkläre JEDEN Fachbegriff sofort wenn er vorkommt, in einfachen Worten in Klammern
- Das gilt für ALLE Dokumenttypen: Verträge, Rechnungen, Bescheide, Briefe, Urteile, Formulare usw.
- Fachbegriffe aus Recht, Finanzen, Medizin, Technik, Behörden — alles muss erklärt werden
- Stelle dir immer vor, du erklärst es jemandem der dieses Thema noch nie gehört hat
- Hebe wichtige Zahlen, Beträge, Fristen und Deadlines mit **fett** hervor
- Schreibe kurze, klare Sätze — maximal 2 Zeilen pro Punkt

Strukturiere deine Antwort IMMER exakt so mit Markdown:

## 📋 Worum geht es?
Erkläre zuerst in 2-3 Sätzen was diese Art von Dokument grundsätzlich ist und wozu es dient.
Dann erkläre den konkreten Inhalt dieses spezifischen Dokuments.

## 🔍 Die wichtigsten Punkte
- Erkläre jeden Punkt einzeln
- Fachbegriffe sofort in Klammern erklären, z.B.: Zinssatz (= der Preis den du für geliehenes Geld zahlst)
- Wichtige Zahlen und Beträge **fett** markieren

## ⚠️ Risiken & Fristen
Nur wenn vorhanden — sonst weglassen:
- Fristen und Deadlines **fett** markieren mit konkretem Datum oder Zeitraum
- Konsequenzen klar erklären: was passiert wenn man nichts tut oder zu spät reagiert?

## ✅ Was muss ich tun?
1. Konkreter Handlungsschritt
2. Konkreter Handlungsschritt
3. usw.

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
          content: `Du bist ELI10, ein Assistent der komplexe Texte so erklärt, dass ein Mensch ohne Fachkenntnisse sie vollständig versteht.
Erkenne automatisch die Sprache des Textes und antworte in derselben Sprache.

PFLICHTREGELN — halte dich IMMER daran:
- Erkläre zuerst die Grundidee des Dokuments (Was ist dieses Dokument? Worum geht es grundsätzlich?)
- Erkläre JEDEN Fachbegriff sofort wenn er vorkommt, in einfachen Worten in Klammern
- Das gilt für ALLE Dokumenttypen: Verträge, Rechnungen, Bescheide, Briefe, Urteile, Formulare usw.
- Fachbegriffe aus Recht, Finanzen, Medizin, Technik, Behörden — alles muss erklärt werden
- Stelle dir immer vor, du erklärst es jemandem der dieses Thema noch nie gehört hat
- Hebe wichtige Zahlen, Beträge, Fristen und Deadlines mit **fett** hervor
- Schreibe kurze, klare Sätze — maximal 2 Zeilen pro Punkt

Strukturiere deine Antwort IMMER exakt so mit Markdown:

## 📋 Worum geht es?
Erkläre zuerst in 2-3 Sätzen was diese Art von Dokument grundsätzlich ist und wozu es dient.
Dann erkläre den konkreten Inhalt dieses spezifischen Dokuments.

## 🔍 Die wichtigsten Punkte
- Erkläre jeden Punkt einzeln
- Fachbegriffe sofort in Klammern erklären, z.B.: Zinssatz (= der Preis den du für geliehenes Geld zahlst)
- Wichtige Zahlen und Beträge **fett** markieren

## ⚠️ Risiken & Fristen
Nur wenn vorhanden — sonst weglassen:
- Fristen und Deadlines **fett** markieren mit konkretem Datum oder Zeitraum
- Konsequenzen klar erklären: was passiert wenn man nichts tut oder zu spät reagiert?

## ✅ Was muss ich tun?
1. Konkreter Handlungsschritt
2. Konkreter Handlungsschritt
3. usw.

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
          content: `Du bist ELI10, ein Assistent der komplexe Texte so erklärt, dass ein Mensch ohne Fachkenntnisse sie vollständig versteht.
Erkenne automatisch die Sprache des Textes und antworte in derselben Sprache.

PFLICHTREGELN — halte dich IMMER daran:
- Erkläre zuerst die Grundidee des Dokuments (Was ist dieses Dokument? Worum geht es grundsätzlich?)
- Erkläre JEDEN Fachbegriff sofort wenn er vorkommt, in einfachen Worten in Klammern
- Das gilt für ALLE Dokumenttypen: Verträge, Rechnungen, Bescheide, Briefe, Urteile, Formulare usw.
- Fachbegriffe aus Recht, Finanzen, Medizin, Technik, Behörden — alles muss erklärt werden
- Stelle dir immer vor, du erklärst es jemandem der dieses Thema noch nie gehört hat
- Hebe wichtige Zahlen, Beträge, Fristen und Deadlines mit **fett** hervor
- Schreibe kurze, klare Sätze — maximal 2 Zeilen pro Punkt

Strukturiere deine Antwort IMMER exakt so mit Markdown:

## 📋 Worum geht es?
Erkläre zuerst in 2-3 Sätzen was diese Art von Dokument grundsätzlich ist und wozu es dient.
Dann erkläre den konkreten Inhalt dieses spezifischen Dokuments.

## 🔍 Die wichtigsten Punkte
- Erkläre jeden Punkt einzeln
- Fachbegriffe sofort in Klammern erklären, z.B.: Zinssatz (= der Preis den du für geliehenes Geld zahlst)
- Wichtige Zahlen und Beträge **fett** markieren

## ⚠️ Risiken & Fristen
Nur wenn vorhanden — sonst weglassen:
- Fristen und Deadlines **fett** markieren mit konkretem Datum oder Zeitraum
- Konsequenzen klar erklären: was passiert wenn man nichts tut oder zu spät reagiert?

## ✅ Was muss ich tun?
1. Konkreter Handlungsschritt
2. Konkreter Handlungsschritt
3. usw.

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

app.post('/chat', async (req, res) => {
  const { user_id, session_id, message } = req.body;
  const FREE_LIMIT = 5;
  const today = new Date().toISOString().split('T')[0];

  try {
    // Premium check
    const { data: sessionData } = await supabase.auth.admin.getUserById(user_id);
    const userEmail = sessionData?.user?.email;
    const { data: userData } = await supabase.from('users').select('plan').eq('email', userEmail).single();
    const isPremium = userData?.plan === 'premium';

    // Usage check für Free User
    if (!isPremium) {
      const { data: usageData } = await supabase.from('usage').select('count').eq('user_id', user_id).eq('date', today).single();
      const count = usageData?.count || 0;
      if (count >= FREE_LIMIT) {
        return res.status(429).json({ error: 'LIMIT_REACHED' });
      }
      await supabase.from('usage').upsert({ user_id, date: today, count: count + 1 }, { onConflict: 'user_id,date' });
    }

    // Bisherigen Chatverlauf laden
    const { data: history } = await supabase
      .from('chats')
      .select('role, message')
      .eq('user_id', user_id)
      .eq('session_id', session_id)
      .order('created_at', { ascending: true });

    const messages = (history || []).map(h => ({
      role: h.role,
      content: h.message
    }));

    // Neue Nachricht anhängen
    messages.push({ role: 'user', content: message });

    // Nachricht in DB speichern
    await supabase.from('chats').insert({ user_id, session_id, role: 'user', message });

    // Groq API aufrufen
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Du bist ELI10, ein Assistent der komplexe Themen und Dokumente so erklärt, dass ein Mensch ohne Fachkenntnisse sie vollständig versteht.
Erkenne automatisch die Sprache der Nachricht und antworte in derselben Sprache.

PFLICHTREGELN:
- Erkläre JEDEN Fachbegriff sofort in Klammern, z.B.: API (= eine Schnittstelle die zwei Programme miteinander verbindet)
- Stelle dir vor du erklärst es jemandem der dieses Thema noch nie gehört hat
- Hebe wichtige Begriffe mit **fett** hervor
- Beantworte Rückfragen immer im Kontext des bisherigen Gesprächs
- Schreibe kurze, klare Sätze

Wenn es eine erste Erklärung ist, strukturiere sie so:
## 📋 Was ist das?
## 🔍 Die wichtigsten Punkte
## 💡 Zusammenfassung

Bei Rückfragen antworte natürlich und direkt ohne starre Struktur.`
        },
        ...messages
      ],
      max_tokens: 1000
    });

    const reply = completion.choices[0].message.content;

    // Antwort in DB speichern
    await supabase.from('chats').insert({ user_id, session_id, role: 'assistant', message: reply });

    res.json({ reply, session_id });

  } catch (err) {
    console.error('Chat Fehler:', err.message);
    res.status(500).json({ error: 'Fehler beim Chat' });
  }
});

app.get('/chat/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    // Alle Sessions des Users laden (letzte Nachricht pro Session)
    const { data } = await supabase
      .from('chats')
      .select('session_id, message, created_at')
      .eq('user_id', user_id)
      .eq('role', 'user')
      .order('created_at', { ascending: false });

    // Erste Nachricht pro Session als Titel
    const sessions = {};
    (data || []).forEach(row => {
      if (!sessions[row.session_id]) {
        sessions[row.session_id] = {
          session_id: row.session_id,
          title: row.message.substring(0, 60) + (row.message.length > 60 ? '...' : ''),
          created_at: row.created_at
        };
      }
    });

    res.json(Object.values(sessions));
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Chats' });
  }
});

app.get('/chat/:user_id/:session_id', async (req, res) => {
  const { user_id, session_id } = req.params;
  try {
    const { data } = await supabase
      .from('chats')
      .select('role, message, created_at')
      .eq('user_id', user_id)
      .eq('session_id', session_id)
      .order('created_at', { ascending: true });

    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden' });
  }
});

// Profilbild hochladen
app.post('/upload-avatar', async (req, res) => {
  const { user_id, image_base64, file_ext } = req.body;
  try {
    const { data: userData } = await supabase.auth.admin.getUserById(user_id);
    const email = userData?.user?.email;
    const fileName = `${user_id}.${file_ext}`;
    const buffer = Buffer.from(image_base64, 'base64');
    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(fileName, buffer, { contentType: `image/${file_ext}`, upsert: true });
    if (uploadError) return res.status(500).json({ error: uploadError.message });
    const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(fileName);
    await supabase.from('users').update({ avatar_url: urlData.publicUrl }).eq('email', email);
    res.json({ avatar_url: urlData.publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Anzeigename speichern
app.post('/update-profile', async (req, res) => {
  const { user_id, display_name } = req.body;
  try {
    const { data: userData } = await supabase.auth.admin.getUserById(user_id);
    const email = userData?.user?.email;
    await supabase.from('users').update({ display_name }).eq('email', email);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Passwort ändern
app.post('/change-password', async (req, res) => {
  const { user_id, new_password } = req.body;
  try {
    const { error } = await supabase.auth.admin.updateUserById(user_id, { password: new_password });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Account löschen
app.post('/delete-account', async (req, res) => {
  const { user_id } = req.body;
  try {
    const { data: userData } = await supabase.auth.admin.getUserById(user_id);
    const email = userData?.user?.email;
    await supabase.from('users').delete().eq('email', email);
    await supabase.from('usage').delete().eq('user_id', user_id);
    await supabase.from('history').delete().eq('user_id', user_id);
    await supabase.from('chats').delete().eq('user_id', user_id);
    await supabase.auth.admin.deleteUser(user_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Profildaten laden
app.post('/get-profile', async (req, res) => {
  const { user_id } = req.body;
  try {
    const { data: userData } = await supabase.auth.admin.getUserById(user_id);
    const email = userData?.user?.email;
    const { data } = await supabase.from('users').select('display_name, avatar_url, plan, created_at').eq('email', email).single();
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('ELI10 läuft auf Port 3000');
});

module.exports = app;
