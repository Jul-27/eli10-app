const express = require('express');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
require('dotenv').config();

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Webhook braucht raw body — muss VOR express.json() stehen
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  res.send(fs.readFileSync(htmlPath, 'utf8'));
});

// Stripe Webhook
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook Fehler:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'customer.subscription.created') {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    const customer = await stripe.customers.retrieve(customerId);
    const email = customer.email;
    await supabase.from('users').upsert({ id: customerId, email, plan: 'premium' });
    console.log(`Premium aktiviert für: ${email}`);
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    await supabase.from('users').update({ plan: 'free' }).eq('id', customerId);
    console.log(`Premium deaktiviert für customer: ${customerId}`);
  }

  res.json({ received: true });
});

// ── System Prompt (geteilt) ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `Du bist Dokuvo, ein KI-Assistent der komplexe Texte so erklärt, dass ein Mensch ohne Fachkenntnisse sie vollständig versteht.
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
Ein einziger, klarer Satz der alles zusammenfasst.`;

// ── Fristen aus Text extrahieren ─────────────────────────────────────────────
async function extrahiereFristen(text) {
  try {
    const heute = new Date().toISOString().split('T')[0];
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: `Du extrahierst Fristen und Termine aus Dokumenten. Heute ist ${heute}.
Antworte NUR mit einem JSON-Array. Jedes Element hat: "titel" (kurze Bezeichnung, max 50 Zeichen), "datum" (im Format YYYY-MM-DD), "beschreibung" (1 Satz was bis dann passieren muss).
Nur Fristen mit konkretem Datum aufnehmen. Keine vergangenen Daten. Wenn keine Fristen gefunden: leeres Array [].
Beispiel: [{"titel":"Widerrufsrecht endet","datum":"2024-03-15","beschreibung":"Bis zu diesem Datum kannst du den Vertrag ohne Angabe von Gründen widerrufen."}]`
        },
        { role: 'user', content: `Extrahiere alle Fristen aus diesem Text:\n\n${text.substring(0, 8000)}` }
      ]
    });
    const raw = completion.choices[0].message.content.trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const fristen = JSON.parse(match[0]);
    // Nur zukünftige Daten
    return fristen.filter(f => f.datum && new Date(f.datum) > new Date());
  } catch(e) { return []; }
}

// ── Folgefragen generieren ────────────────────────────────────────────────────
async function generiereFollowUps(erklaerung) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'Generiere genau 3 kurze, natürliche Folgefragen die ein Nutzer nach dieser Erklärung stellen könnte. Antworte NUR mit einem JSON-Array, z.B.: ["Frage 1?","Frage 2?","Frage 3?"]. Keine anderen Texte.' },
        { role: 'user', content: `Erklärung:\n${erklaerung}\n\nGib 3 Folgefragen als JSON-Array aus.` }
      ]
    });
    const raw = completion.choices[0].message.content.trim();
    const match = raw.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch(e) { return []; }
}
async function extractPdfText(buffer) {
  // pdf-parse Vercel-Workaround: direkt die lib laden, nicht den Wrapper
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const data = await pdfParse(buffer);
  return data.text;
}

// ── Dokument hochladen und analysieren ───────────────────────────────────────
app.post('/upload-document', upload.single('document'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Kein Dokument hochgeladen' });
  }
  const depth = parseInt(req.body.depth) || 2;
  const depthInstructions = {
    1: 'Erkläre so einfach wie möglich, als würdest du mit einem Kind sprechen. Kurze Sätze, keine Fachbegriffe.',
    2: 'Erkläre verständlich für jemanden ohne Fachkenntnisse. Fachbegriffe kurz in Klammern erklären.',
    3: 'Erkläre präzise und fachlich korrekt. Fachbegriffe dürfen verwendet werden.'
  };

  try {
    let text = '';

    if (req.file.mimetype === 'application/pdf') {
      try {
        text = await extractPdfText(req.file.buffer);
      } catch (pdfErr) {
        console.error('PDF Parse Fehler:', pdfErr.message);
        return res.status(400).json({ 
          error: 'PDF konnte nicht gelesen werden. Bitte stelle sicher, dass das PDF Text enthält (kein gescanntes Bild).' 
        });
      }
    }

    if (!text || text.trim().length < 10) {
      return res.status(400).json({ 
        error: 'Kein Text im Dokument gefunden. Falls es ein gescanntes PDF ist, bitte als Foto hochladen.' 
      });
    }

    const cleanText = text.replace(/\s+/g, ' ').trim();
    const truncatedText = cleanText.substring(0, 12000);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + `\n\nERKLÄRUNGSTIEFE: ${depthInstructions[depth]}` },
        { role: 'user', content: `Analysiere dieses Dokument genau und erkläre mir alle wichtigen Informationen darin. Extrahiere konkret: Fahrzeug- oder Produktdetails, alle Preise und Kosten, alle Fristen und Gültigkeitsdaten, Konditionen und Bedingungen, sowie alle Aktionen oder Rabatte. Erkläre jeden Fachbegriff sofort in Klammern.\n\nDOKUMENT:\n${truncatedText}` }
      ]
    });

    const explanation = completion.choices[0].message.content;
    const [followUps, fristen] = await Promise.all([
      generiereFollowUps(explanation),
      extrahiereFristen(truncatedText)
    ]);
    res.json({ explanation, followUps, fristen });

  } catch (error) {
    console.error('Upload Fehler:', error.message);
    res.status(500).json({ error: 'Dokument konnte nicht verarbeitet werden.' });
  }
});

// ── Status prüfen ─────────────────────────────────────────────────────────────
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

// ── Foto analysieren (Groq Vision) ───────────────────────────────────────────
app.post('/analyze-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Kein Bild hochgeladen' });
  }
  const depth = parseInt(req.body.depth) || 2;
  const depthInstructions = {
    1: 'Erkläre so einfach wie möglich, als würdest du mit einem Kind sprechen. Kurze Sätze, keine Fachbegriffe.',
    2: 'Erkläre verständlich für jemanden ohne Fachkenntnisse. Fachbegriffe kurz in Klammern erklären.',
    3: 'Erkläre präzise und fachlich korrekt. Fachbegriffe dürfen verwendet werden.'
  };

  try {
    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const completion = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 1500,
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT + `\n\nERKLÄRUNGSTIEFE: ${depthInstructions[depth]}`
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Image}` }
            },
            {
              type: 'text',
              text: 'Analysiere dieses Bild genau. Falls es Text enthält (Dokument, Brief, Formular, Rechnung usw.), erkläre alle wichtigen Informationen daraus: Preise, Fristen, Bedingungen, Handlungsschritte. Falls es kein Textdokument ist, beschreibe und erkläre was du siehst. Erkläre jeden Fachbegriff sofort in Klammern.'
            }
          ]
        }
      ]
    });

    const explanation = completion.choices[0].message.content;
    const [followUps, fristen] = await Promise.all([
      generiereFollowUps(explanation),
      extrahiereFristen(explanation)
    ]);
    res.json({ explanation, followUps, fristen });

  } catch (error) {
    console.error('Vision Fehler:', error.message);
    res.status(500).json({ error: 'Bild konnte nicht verarbeitet werden.' });
  }
});

// ── Checkout Session erstellen ────────────────────────────────────────────────
app.post('/create-checkout', async (req, res) => {
  const { user_id, email } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
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

// ── Nach erfolgreichem Kauf ───────────────────────────────────────────────────
app.get('/success', async (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'success.html');
  res.send(fs.readFileSync(htmlPath, 'utf8'));
});

// ── Chat ─────────────────────────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { user_id, session_id, message, depth = 2 } = req.body;
  const depthInstructions = {
    1: 'Erkläre so einfach wie möglich, als würdest du mit einem Kind sprechen. Kurze Sätze, keine Fachbegriffe, nur Alltagssprache und Beispiele aus dem Alltag.',
    2: 'Erkläre verständlich für jemanden ohne Fachkenntnisse. Fachbegriffe kurz in Klammern erklären.',
    3: 'Erkläre präzise und fachlich korrekt. Fachbegriffe dürfen verwendet werden, aber trotzdem klar strukturiert.'
  };
  const FREE_LIMIT = 5;
  const today = new Date().toISOString().split('T')[0];

  try {
    const { data: sessionData } = await supabase.auth.admin.getUserById(user_id);
    const userEmail = sessionData?.user?.email;
    const { data: userData } = await supabase.from('users').select('plan').eq('email', userEmail).single();
    const isPremium = userData?.plan === 'premium';

    if (!isPremium) {
      const { data: usageData } = await supabase.from('usage').select('count').eq('user_id', user_id).eq('date', today).single();
      const count = usageData?.count || 0;
      if (count >= FREE_LIMIT) {
        return res.status(429).json({ error: 'LIMIT_REACHED' });
      }
      await supabase.from('usage').upsert({ user_id, date: today, count: count + 1 }, { onConflict: 'user_id,date' });
    }

    const { data: history } = await supabase
      .from('chats')
      .select('role, message')
      .eq('user_id', user_id)
      .eq('session_id', session_id)
      .order('created_at', { ascending: true });

    const messages = (history || []).map(h => ({ role: h.role, content: h.message }));
    messages.push({ role: 'user', content: message });

    await supabase.from('chats').insert({ user_id, session_id, role: 'user', message });

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Du bist Dokuvo, ein KI-Assistent der komplexe Themen und Dokumente erklärt.
Erkenne automatisch die Sprache der Nachricht und antworte in derselben Sprache.

ERKLÄRUNGSTIEFE: ${depthInstructions[depth] || depthInstructions[2]}

PFLICHTREGELN:
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
    await supabase.from('chats').insert({ user_id, session_id, role: 'assistant', message: reply });

    const followUps = await generiereFollowUps(reply);
    res.json({ reply, session_id, followUps });

  } catch (err) {
    console.error('Chat Fehler:', err.message);
    res.status(500).json({ error: 'Fehler beim Chat' });
  }
});

// ── Feedback ──────────────────────────────────────────────────────────────────
app.post('/feedback', async (req, res) => {
  const { user_id, session_id, message, rating } = req.body;
  try {
    await supabase.from('feedback').insert({ user_id, session_id, message, rating });
    res.json({ ok: true });
  } catch (err) {
    console.error('Feedback Fehler:', err.message);
    res.status(500).json({ error: 'Fehler beim Speichern' });
  }
});

// ── Chat Session löschen ──────────────────────────────────────────────────────
app.delete('/chat/:user_id/:session_id', async (req, res) => {
  const { user_id, session_id } = req.params;
  try {
    await supabase
      .from('chats')
      .delete()
      .eq('user_id', user_id)
      .eq('session_id', session_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Chat Sessions laden ───────────────────────────────────────────────────────
app.get('/chat/:user_id', async (req, res) => {
  const { user_id } = req.params;
  try {
    const { data } = await supabase
      .from('chats')
      .select('session_id, message, created_at')
      .eq('user_id', user_id)
      .eq('role', 'user')
      .order('created_at', { ascending: false });

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

// ── Einzelne Chat Session laden ───────────────────────────────────────────────
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

// ── Profilbild hochladen ──────────────────────────────────────────────────────
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

// ── Anzeigename speichern ─────────────────────────────────────────────────────
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

// ── Passwort ändern ───────────────────────────────────────────────────────────
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

// ── Account löschen ───────────────────────────────────────────────────────────
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

// ── Profildaten laden ─────────────────────────────────────────────────────────
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
  console.log('Dokuvo läuft auf Port 3000');
});

module.exports = app;
