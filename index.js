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

// ── Auth-Middleware: prüft ob user_id gültig ist ────────────────────────────
async function verifyUser(req, res, next) {
  const user_id = req.body.user_id || req.params.user_id || req.query.user_id || req.headers['x-user-id'];
  if (!user_id) return res.status(401).json({ error: 'Nicht autorisiert' });
  try {
    const { data, error } = await supabase.auth.admin.getUserById(user_id);
    if (error || !data?.user) return res.status(401).json({ error: 'Ungültige Sitzung' });
    req.authUser = data.user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentifizierung fehlgeschlagen' });
  }
}

// ── Usage-Limit: prüft und zählt Verbrauch für Free-User ────────────────────
const FREE_LIMIT = 5;

async function checkAndCountUsage(user_id) {
  const today = new Date().toISOString().split('T')[0];
  // Premium-Check
  const { data: sessionData } = await supabase.auth.admin.getUserById(user_id);
  const userEmail = sessionData?.user?.email;
  const { data: userData } = await supabase.from('users').select('plan').eq('email', userEmail).single();
  const isPremium = userData?.plan === 'premium';

  if (isPremium) return { allowed: true, remaining: 999, isPremium: true };

  // Free-User: Verbrauch prüfen
  const { data: usageData } = await supabase.from('usage').select('count').eq('user_id', user_id).eq('date', today).single();
  const count = usageData?.count || 0;

  if (count >= FREE_LIMIT) {
    return { allowed: false, remaining: 0, isPremium: false };
  }

  // Verbrauch hochzählen
  await supabase.from('usage').upsert({ user_id, date: today, count: count + 1 }, { onConflict: 'user_id,date' });
  return { allowed: true, remaining: FREE_LIMIT - count - 1, isPremium: false };
}

app.get('/', (req, res) => {
  const landingPath = path.join(__dirname, 'public', 'landing.html');
  if (fs.existsSync(landingPath)) {
    res.send(fs.readFileSync(landingPath, 'utf8'));
  } else {
    // Fallback: wenn landing.html noch nicht existiert, zeige die App
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    res.send(fs.readFileSync(htmlPath, 'utf8'));
  }
});

app.get('/app', (req, res) => {
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

FORMATIERUNG — verwende KEINE Aufzählungszeichen (-) oder Bullet Points (*). Verwende stattdessen nummerierte Absätze oder Fließtext.

Strukturiere deine Antwort IMMER exakt so mit Markdown:

## Worum geht es?
Erkläre zuerst in 2-3 Sätzen was diese Art von Dokument grundsätzlich ist und wozu es dient.
Dann erkläre den konkreten Inhalt dieses spezifischen Dokuments.

## Die wichtigsten Punkte
Erkläre jeden Punkt als nummerierten Absatz:
1. **Erster Punkt:** Erklärung mit Fachbegriff in Klammern
2. **Zweiter Punkt:** Erklärung mit wichtigen Zahlen **fett**
3. usw.

## Risiken und Fristen
Nur wenn vorhanden — sonst weglassen:
1. **Frist/Risiko:** Erklärung mit konkretem Datum oder Zeitraum **fett**
2. **Konsequenz:** Was passiert wenn man nichts tut oder zu spät reagiert?

## Was muss ich tun?
1. Konkreter Handlungsschritt
2. Konkreter Handlungsschritt
3. usw.

## Zusammenfassung
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

// ── Risiko-Analyse (Ampel) ──────────────────────────────────────────────────
async function analysiereRisiken(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      max_tokens: 800,
      messages: [
        { role: 'system', content: `Du bist ein Dokumenten-Analyst. Analysiere den Text und identifiziere NUR die wirklich wichtigen Klauseln oder Bedingungen, die den Leser direkt betreffen. Ignoriere Standardklauseln und Selbstverständlichkeiten.

Bewerte jede mit einem Risiko-Level:
- "rot" = gefährlich oder klar nachteilig für den Leser (z.B. Haftungsausschlüsse, versteckte Kosten, einseitige Kündigungsrechte, automatische Verlängerungen, Gewährleistungsausschlüsse)
- "gelb" = beachtenswert, könnte problematisch werden (z.B. knappe Fristen, besondere Bedingungen, Einschränkungen)
- "gruen" = positiv oder fair für den Leser (z.B. Widerrufsrecht, Garantien, Verbraucherschutz)

WICHTIG: Nenne NUR Klauseln die für den Leser wirklich handlungsrelevant sind. Keine trivialen Punkte wie "Eigentum geht über" oder "Vertrag wird aufgelöst". Maximal 6 Klauseln.

Antworte NUR mit einem JSON-Array. Jedes Element hat: {"klausel": "Kurzbeschreibung (max 80 Zeichen)", "risiko": "rot"|"gelb"|"gruen", "grund": "Warum diese Bewertung (max 100 Zeichen)"}. Keine anderen Texte.` },
        { role: 'user', content: `Analysiere diesen Text auf Risiken:\n${text.substring(0, 8000)}` }
      ]
    });
    const raw = completion.choices[0].message.content.trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const risiken = JSON.parse(match[0]);
    // Sortierung: rot zuerst, dann gelb, dann gruen
    const order = { rot: 0, gelb: 1, gruen: 2, grün: 2 };
    risiken.sort((a, b) => (order[a.risiko] ?? 2) - (order[b.risiko] ?? 2));
    // Normalize grün → gruen für Frontend-Konsistenz
    risiken.forEach(r => { if (r.risiko === 'grün') r.risiko = 'gruen'; });
    return risiken;
  } catch(e) { return []; }
}

// ── 1-Seite Zusammenfassung ─────────────────────────────────────────────────
async function generiereZusammenfassung(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      max_tokens: 700,
      messages: [
        { role: 'system', content: `Erstelle eine strukturierte Zusammenfassung des Dokuments. Passe die Felder an den Dokumenttyp an!

Antworte NUR mit einem JSON-Objekt mit diesen Feldern:
- "typ": Art des Dokuments (z.B. "Mietvertrag", "Rechnung", "Arztbefund", "Finanzierungsangebot")
- "parteien": Array der beteiligten Parteien (z.B. ["Vermieter: Max Müller", "Mieter: Anna Schmidt"])
- "kernpunkte": Array der 3-5 wichtigsten Punkte (kurze Strings, max 80 Zeichen je)
- "felder": Array von {"label": "Feldname", "wert": "Wert"} — wähle 3-4 Felder die zum Dokumenttyp passen:
  * Bei Verträgen: Kosten, Laufzeit, Kündigungsfrist, Beginn
  * Bei Rechnungen: Betrag, Zahlungsfrist, Rechnungsdatum, Rechnungsnummer
  * Bei Angeboten: Preis, Gültigkeit, Konditionen, Rabatt
  * Bei Befunden: Diagnose, Therapie, Nächster Termin
  * Bei Bescheiden: Ergebnis, Frist für Widerspruch, Zuständige Behörde
  * Bei sonstigen: wähle passende Felder. Lasse irrelevante Felder WEG.

NUR das JSON-Objekt, keine anderen Texte.` },
        { role: 'user', content: `Fasse dieses Dokument zusammen:\n${text.substring(0, 8000)}` }
      ]
    });
    const raw = completion.choices[0].message.content.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch(e) { return null; }
}

// ── Handlungsempfehlungen ───────────────────────────────────────────────────
async function generiereHandlungsempfehlungen(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 400,
      messages: [
        { role: 'system', content: `Du bist ein praktischer Berater. Basierend auf dem Dokument, generiere konkrete Handlungsempfehlungen — was sollte der Leser jetzt tun? Antworte NUR mit einem JSON-Array von Objekten: {"aktion": "Was zu tun ist (max 80 Zeichen)", "prioritaet": "hoch"|"mittel"|"niedrig", "frist": "Bis wann (oder null)"}. Maximal 5 Empfehlungen, sortiert nach Priorität. Keine anderen Texte.` },
        { role: 'user', content: `Welche konkreten Handlungen ergeben sich aus diesem Dokument?\n${text.substring(0, 8000)}` }
      ]
    });
    const raw = completion.choices[0].message.content.trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const handlungen = JSON.parse(match[0]);
    const order = { hoch: 0, mittel: 1, niedrig: 2 };
    handlungen.sort((a, b) => (order[a.prioritaet] ?? 2) - (order[b.prioritaet] ?? 2));
    return handlungen;
  } catch(e) { return []; }
}

// ── Glossar-Extraktion ──────────────────────────────────────────────────────
async function extrahiereGlossar(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        { role: 'system', content: `Identifiziere alle Fachbegriffe und juristischen/medizinischen/technischen Begriffe im Text. Antworte NUR mit einem JSON-Array von Objekten: {"begriff": "Der Fachbegriff", "erklaerung": "Einfache Erklärung in 1-2 Sätzen"}. Maximal 10 Begriffe, nur wirklich erklärungsbedürftige Fachbegriffe. Keine anderen Texte.` },
        { role: 'user', content: `Extrahiere Fachbegriffe aus:\n${text.substring(0, 8000)}` }
      ]
    });
    const raw = completion.choices[0].message.content.trim();
    const match = raw.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch(e) { return []; }
}

// ── Checklisten-Generator ───────────────────────────────────────────────────
async function generiereCheckliste(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 400,
      messages: [
        { role: 'system', content: `Erstelle aus dem Dokument eine praktische Checkliste mit allen Aufgaben, Pflichten und Deadlines die der Leser beachten muss. Antworte NUR mit einem JSON-Array von Strings — jeder String ist ein Checklisten-Punkt (max 80 Zeichen). Maximal 8 Punkte. Keine anderen Texte.` },
        { role: 'user', content: `Erstelle eine Checkliste aus:\n${text.substring(0, 8000)}` }
      ]
    });
    const raw = completion.choices[0].message.content.trim();
    const match = raw.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch(e) { return []; }
}
// ── Dokument-Statistiken (reine Textanalyse) ─────────────────────────────────
function berechneStatistiken(text) {
  const woerter = text.trim().split(/\s+/).filter(w => w.length > 0);
  const wortanzahl = woerter.length;
  const zeichenanzahl = text.replace(/\s/g, '').length;
  const lesezeit = Math.ceil(wortanzahl / 200);
  const saetze = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const satzanzahl = saetze.length;
  const durchschnittSatzlaenge = satzanzahl > 0 ? Math.round(wortanzahl / satzanzahl) : 0;
  return { wortanzahl, zeichenanzahl, lesezeit, satzanzahl, durchschnittSatzlaenge };
}

// ── PDF-Annotationen ────────────────────────────────────────────────────────
async function extrahiereAnnotationen(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        { role: 'system', content: `Identifiziere maximal 6 wirklich wichtige Textstellen im Dokument. Nur Stellen die der Leser unbedingt kennen muss.
Antworte NUR mit einem JSON-Array. Jedes Element hat:
- "stelle": exakter Textausschnitt aus dem Dokument (max 100 Zeichen)
- "typ": "risiko"|"frist"|"kosten"|"wichtig"
- "kommentar": warum diese Stelle wichtig ist (max 60 Zeichen)
Keine anderen Texte. Wenn keine wichtigen Stellen: leeres Array [].` },
        { role: 'user', content: `Markiere die wichtigsten Stellen in diesem Dokument:\n\n${text.substring(0, 8000)}` }
      ]
    });
    const raw = completion.choices[0].message.content.trim();
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const annotationen = JSON.parse(match[0]);
    return annotationen.slice(0, 6);
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
  const user_id = req.body.user_id;
  if (user_id) {
    const usage = await checkAndCountUsage(user_id);
    if (!usage.allowed) return res.status(429).json({ error: 'LIMIT_REACHED', remaining: 0 });
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
    const statistiken = berechneStatistiken(cleanText);
    const [followUps, fristen, risiken, zusammenfassung, handlungen, glossar, checkliste, annotationen] = await Promise.all([
      generiereFollowUps(explanation),
      extrahiereFristen(truncatedText),
      analysiereRisiken(truncatedText),
      generiereZusammenfassung(truncatedText),
      generiereHandlungsempfehlungen(truncatedText),
      extrahiereGlossar(truncatedText),
      generiereCheckliste(truncatedText),
      extrahiereAnnotationen(truncatedText)
    ]);
    res.json({ explanation, followUps, fristen, risiken, zusammenfassung, handlungen, glossar, checkliste, annotationen, statistiken });

  } catch (error) {
    console.error('Upload Fehler:', error.message);
    res.status(500).json({ error: 'Dokument konnte nicht verarbeitet werden.' });
  }
});

// ── Status prüfen ─────────────────────────────────────────────────────────────
app.post('/check-status', verifyUser, async (req, res) => {
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
  const user_id = req.body.user_id;
  if (user_id) {
    const usage = await checkAndCountUsage(user_id);
    if (!usage.allowed) return res.status(429).json({ error: 'LIMIT_REACHED', remaining: 0 });
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
    const statistiken = berechneStatistiken(explanation);
    const [followUps, fristen, risiken, zusammenfassung, handlungen, glossar, checkliste] = await Promise.all([
      generiereFollowUps(explanation),
      extrahiereFristen(explanation),
      analysiereRisiken(explanation),
      generiereZusammenfassung(explanation),
      generiereHandlungsempfehlungen(explanation),
      extrahiereGlossar(explanation),
      generiereCheckliste(explanation)
    ]);
    res.json({ explanation, followUps, fristen, risiken, zusammenfassung, handlungen, glossar, checkliste, statistiken });

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
app.post('/chat', verifyUser, async (req, res) => {
  const { user_id, session_id, message, depth = 2 } = req.body;
  const depthInstructions = {
    1: 'Erkläre so einfach wie möglich, als würdest du mit einem Kind sprechen. Kurze Sätze, keine Fachbegriffe, nur Alltagssprache und Beispiele aus dem Alltag.',
    2: 'Erkläre verständlich für jemanden ohne Fachkenntnisse. Fachbegriffe kurz in Klammern erklären.',
    3: 'Erkläre präzise und fachlich korrekt. Fachbegriffe dürfen verwendet werden, aber trotzdem klar strukturiert.'
  };

  try {
    const usage = await checkAndCountUsage(user_id);
    if (!usage.allowed) {
      return res.status(429).json({ error: 'LIMIT_REACHED' });
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
## Was ist das?
## Die wichtigsten Punkte
## Zusammenfassung

Verwende KEINE Aufzählungszeichen (-) oder Bullet Points (*). Verwende stattdessen nummerierte Absätze oder Fließtext.
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
app.post('/feedback', verifyUser, async (req, res) => {
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
app.delete('/chat/:user_id/:session_id', verifyUser, async (req, res) => {
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
app.get('/chat/:user_id', verifyUser, async (req, res) => {
  const { user_id } = req.params;
  try {
    const { data } = await supabase
      .from('chats')
      .select('session_id, message, created_at')
      .eq('user_id', user_id)
      .eq('role', 'user')
      .order('created_at', { ascending: false });

    // Custom-Titel laden
    const { data: titles } = await supabase
      .from('chat_titles')
      .select('session_id, title')
      .eq('user_id', user_id);

    const titleMap = {};
    (titles || []).forEach(t => { titleMap[t.session_id] = t.title; });

    const sessions = {};
    (data || []).forEach(row => {
      if (!sessions[row.session_id]) {
        const autoTitle = row.message.substring(0, 60) + (row.message.length > 60 ? '...' : '');
        sessions[row.session_id] = {
          session_id: row.session_id,
          title: titleMap[row.session_id] || autoTitle,
          created_at: row.created_at
        };
      }
    });

    res.json(Object.values(sessions));
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden der Chats' });
  }
});

// ── Google Token erneuern ─────────────────────────────────────────────────────
let googleAccessToken = process.env.GOOGLE_ACCESS_TOKEN;

async function erneuereGoogleToken() {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
        grant_type: 'refresh_token'
      })
    });
    const data = await res.json();
    if (data.access_token) {
      googleAccessToken = data.access_token;
      return true;
    }
    return false;
  } catch(e) {
    return false;
  }
}

// ── Fristen-Alarm via Google Calendar ────────────────────────────────────────
app.post('/kalender-alarm', async (req, res) => {
  const { titel, datum, beschreibung } = req.body;
  try {
    const startDate = new Date(datum);
    startDate.setHours(9, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setHours(10, 0, 0, 0);

    const event = {
      summary: `⏰ ${titel}`,
      description: `${beschreibung}\n\nErstellt von Dokuvo`,
      start: { dateTime: startDate.toISOString(), timeZone: 'Europe/Vienna' },
      end: { dateTime: endDate.toISOString(), timeZone: 'Europe/Vienna' },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 24 * 60 },
          { method: 'email', minutes: 24 * 60 }
        ]
      }
    };

    const kalenderRequest = async (token) => {
      return fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(event)
      });
    };

    let gcalRes = await kalenderRequest(googleAccessToken);

    // Token abgelaufen → erneuern und nochmal versuchen
    if (gcalRes.status === 401) {
      const erneuert = await erneuereGoogleToken();
      if (erneuert) {
        gcalRes = await kalenderRequest(googleAccessToken);
      }
    }

    if (gcalRes.ok) {
      const data = await gcalRes.json();
      res.json({ success: true, eventId: data.id });
    } else {
      res.json({ success: false });
    }
  } catch (err) {
    console.error('Kalender Fehler:', err.message);
    res.json({ success: false });
  }
});

// ── Dokumente vergleichen ─────────────────────────────────────────────────────
app.post('/compare-documents', upload.fields([{ name: 'doc1' }, { name: 'doc2' }]), async (req, res) => {
  const user_id = req.body.user_id;
  if (user_id) {
    const usage = await checkAndCountUsage(user_id);
    if (!usage.allowed) return res.status(429).json({ error: 'LIMIT_REACHED', remaining: 0 });
  }
  const depth = parseInt(req.body.depth) || 2;
  const depthInstructions = {
    1: 'Erkläre so einfach wie möglich, kurze Sätze, keine Fachbegriffe.',
    2: 'Erkläre verständlich für jemanden ohne Fachkenntnisse. Fachbegriffe kurz in Klammern erklären.',
    3: 'Erkläre präzise und fachlich korrekt.'
  };

  try {
    const file1 = req.files['doc1']?.[0];
    const file2 = req.files['doc2']?.[0];
    if (!file1 || !file2) return res.status(400).json({ error: 'Zwei Dokumente erforderlich' });

    // Texte extrahieren
    const extractText = async (file) => {
      if (file.mimetype === 'application/pdf') {
        const pdfParse = require('pdf-parse/lib/pdf-parse.js');
        const data = await pdfParse(file.buffer);
        return data.text.replace(/\s+/g, ' ').trim().substring(0, 8000);
      } else {
        // Bild: Groq Vision
        const base64 = file.buffer.toString('base64');
        const completion = await groq.chat.completions.create({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          max_tokens: 1000,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:${file.mimetype};base64,${base64}` } },
            { type: 'text', text: 'Extrahiere den gesamten Text aus diesem Bild. Gib nur den reinen Text zurück.' }
          ]}]
        });
        return completion.choices[0].message.content.substring(0, 8000);
      }
    };

    const [text1, text2] = await Promise.all([extractText(file1), extractText(file2)]);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1500,
      messages: [
        {
          role: 'system',
          content: `Du bist Dokuvo, ein KI-Assistent der Dokumente vergleicht und erklärt.
${depthInstructions[depth]}

Strukturiere den Vergleich so:
## Worum geht es bei den Dokumenten?
Kurze Beschreibung was beide Dokumente sind.

## Die wichtigsten Unterschiede
Erkläre die konkreten Unterschiede zwischen den Dokumenten — Preise, Konditionen, Fristen, Inhalte.
Nutze eine klare Gegenüberstellung mit nummerierten Punkten (keine Aufzählungszeichen).

## Was ist besser?
Gib eine ehrliche Einschätzung welches Dokument vorteilhafter ist und warum.

## Zusammenfassung
Ein klarer Satz was die wichtigste Erkenntnis aus dem Vergleich ist.`
        },
        {
          role: 'user',
          content: `Vergleiche diese zwei Dokumente:\n\n--- DOKUMENT 1: ${file1.originalname} ---\n${text1}\n\n--- DOKUMENT 2: ${file2.originalname} ---\n${text2}`
        }
      ]
    });

    const comparison = completion.choices[0].message.content;

    // Diff-Analyse: konkrete Unterschiede als strukturiertes JSON
    let diff = [];
    try {
      const diffCompletion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: 'system', content: `Erstelle eine strukturierte Gegenüberstellung der beiden Dokumente. Antworte NUR mit einem JSON-Array. Jedes Element hat:
{"kategorie": "z.B. Preis, Laufzeit, Konditionen, Leistung", "dok1": "Wert/Klausel in Dokument 1", "dok2": "Wert/Klausel in Dokument 2", "vorteil": 1|2|0}
vorteil = 1 wenn Dokument 1 besser, 2 wenn Dokument 2 besser, 0 wenn gleichwertig.
Maximal 8 Vergleichspunkte, nur relevante Unterschiede. Keine anderen Texte.` },
          { role: 'user', content: `Vergleiche:\n\n--- DOKUMENT 1 ---\n${text1.substring(0, 4000)}\n\n--- DOKUMENT 2 ---\n${text2.substring(0, 4000)}` }
        ]
      });
      const raw = diffCompletion.choices[0].message.content.trim();
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) diff = JSON.parse(match[0]);
    } catch(e) { /* diff optional */ }

    const [followUps, fristen] = await Promise.all([
      generiereFollowUps(comparison),
      extrahiereFristen(text1 + ' ' + text2)
    ]);

    res.json({ comparison, followUps, fristen, diff, doc1Name: file1.originalname, doc2Name: file2.originalname });

  } catch (err) {
    console.error('Vergleich Fehler:', err.message);
    res.status(500).json({ error: 'Fehler beim Vergleichen' });
  }
});

// ── Chat-Suche ───────────────────────────────────────────────────────────────
app.post('/chat/search', verifyUser, async (req, res) => {
  const { user_id, query } = req.body;
  if (!query || query.trim().length < 2) {
    return res.json([]);
  }
  const searchTerm = `%${query.trim()}%`;

  try {
    // Suche in Chat-Nachrichten
    const { data: chatResults } = await supabase
      .from('chats')
      .select('session_id, message, role, created_at')
      .eq('user_id', user_id)
      .ilike('message', searchTerm)
      .order('created_at', { ascending: false })
      .limit(50);

    // Suche in Chat-Titeln
    const { data: titleResults } = await supabase
      .from('chat_titles')
      .select('session_id, title')
      .eq('user_id', user_id)
      .ilike('title', searchTerm);

    // Alle Titel laden für die Anzeige
    const { data: allTitles } = await supabase
      .from('chat_titles')
      .select('session_id, title')
      .eq('user_id', user_id);

    const titleMap = {};
    (allTitles || []).forEach(t => { titleMap[t.session_id] = t.title; });

    // Ergebnisse zusammenführen (dedupliziert nach session_id)
    const sessionMap = {};

    // Titel-Treffer zuerst
    (titleResults || []).forEach(t => {
      if (!sessionMap[t.session_id]) {
        sessionMap[t.session_id] = {
          session_id: t.session_id,
          title: t.title,
          matchType: 'title',
          matchText: t.title
        };
      }
    });

    // Chat-Treffer
    (chatResults || []).forEach(c => {
      if (!sessionMap[c.session_id]) {
        // Auto-Titel generieren falls kein Custom-Titel
        const autoTitle = titleMap[c.session_id] || c.message.substring(0, 60) + (c.message.length > 60 ? '...' : '');
        const snippet = c.message.length > 100 ? '...' + c.message.substring(0, 100) + '...' : c.message;
        sessionMap[c.session_id] = {
          session_id: c.session_id,
          title: autoTitle,
          matchType: c.role,
          matchText: snippet,
          created_at: c.created_at
        };
      }
    });

    res.json(Object.values(sessionMap).slice(0, 20));
  } catch (err) {
    res.status(500).json({ error: 'Suchfehler: ' + err.message });
  }
});

// ── Chat umbenennen ───────────────────────────────────────────────────────────
app.post('/chat/rename', verifyUser, async (req, res) => {
  const { user_id, session_id, title } = req.body;
  try {
    await supabase.from('chat_titles').upsert(
      { user_id, session_id, title },
      { onConflict: 'session_id' }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Einzelne Chat Session laden ───────────────────────────────────────────────
app.get('/chat/:user_id/:session_id', verifyUser, async (req, res) => {
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
app.post('/upload-avatar', verifyUser, async (req, res) => {
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
    // Zuerst versuchen zu updaten, wenn 0 rows → insert
    const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
    if (existing) {
      await supabase.from('users').update({ avatar_url: urlData.publicUrl }).eq('email', email);
    } else {
      await supabase.from('users').insert({ id: user_id, email, avatar_url: urlData.publicUrl, plan: 'free' });
    }
    res.json({ avatar_url: urlData.publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Anzeigename speichern ─────────────────────────────────────────────────────
app.post('/update-profile', verifyUser, async (req, res) => {
  const { user_id, display_name } = req.body;
  try {
    const { data: userData } = await supabase.auth.admin.getUserById(user_id);
    const email = userData?.user?.email;
    // Zuerst versuchen zu updaten, wenn 0 rows → insert
    const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
    if (existing) {
      await supabase.from('users').update({ display_name }).eq('email', email);
    } else {
      await supabase.from('users').insert({ id: user_id, email, display_name, plan: 'free' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Passwort ändern ───────────────────────────────────────────────────────────
app.post('/change-password', verifyUser, async (req, res) => {
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
app.post('/delete-account', verifyUser, async (req, res) => {
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
app.post('/get-profile', verifyUser, async (req, res) => {
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

// ── Erklärung teilen (Share erstellen) ───────────────────────────────────────
app.post('/share', verifyUser, async (req, res) => {
  const { user_id, session_id, title, content } = req.body;
  if (!content) return res.status(400).json({ error: 'Kein Inhalt zum Teilen' });

  try {
    const { data, error } = await supabase
      .from('shared_explanations')
      .insert({ user_id, session_id, title: title || 'Dokuvo-Erklärung', content })
      .select('id')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ shareUrl: `${baseUrl}/shared/${data.id}`, shareId: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Geteilte Erklärung anzeigen (öffentlich) ─────────────────────────────────
app.get('/shared/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('shared_explanations')
      .select('title, content, created_at')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
        <title>Nicht gefunden – Dokuvo</title>
        <style>body{font-family:-apple-system,sans-serif;background:#0D0D0D;color:#E8EAED;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
        .box{text-align:center;padding:40px;}.box h1{font-size:2rem;margin-bottom:12px;}.box p{color:#7A7F88;margin-bottom:24px;}
        .box a{color:#3B82F6;text-decoration:none;font-weight:600;}</style>
        </head><body><div class="box"><h1>Nicht gefunden</h1><p>Diese Erklärung existiert nicht oder wurde gelöscht.</p><a href="/">Zurück zu Dokuvo</a></div></body></html>
      `);
    }

    const date = new Date(data.created_at).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });

    res.send(`
      <!DOCTYPE html>
      <html lang="de">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${data.title} – Dokuvo</title>
        <meta name="description" content="Erklärung erstellt mit Dokuvo – Komplexe Dokumente einfach verstehen.">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'DM Sans', -apple-system, sans-serif;
            background: #0D0D0D;
            color: #E8EAED;
            line-height: 1.7;
            -webkit-font-smoothing: antialiased;
          }
          .share-header {
            border-bottom: 1px solid #1A1C1F;
            padding: 16px 24px;
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          .share-logo {
            font-weight: 700;
            font-size: 1.1rem;
            color: #E8EAED;
            text-decoration: none;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .share-cta {
            padding: 8px 20px;
            background: #3B82F6;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 0.85rem;
            font-weight: 600;
            text-decoration: none;
            transition: background 0.2s;
          }
          .share-cta:hover { background: #2563EB; }
          .share-content {
            max-width: 740px;
            margin: 0 auto;
            padding: 48px 24px 80px;
          }
          .share-title {
            font-size: 1.6rem;
            font-weight: 700;
            margin-bottom: 8px;
          }
          .share-meta {
            color: #6B7280;
            font-size: 0.85rem;
            margin-bottom: 32px;
          }
          .share-body {
            font-size: 1rem;
            line-height: 1.8;
            color: #D1D5DB;
          }
          .share-body h1, .share-body h2, .share-body h3 { color: #E8EAED; margin: 24px 0 12px; }
          .share-body ul, .share-body ol { padding-left: 24px; margin: 12px 0; }
          .share-body li { margin-bottom: 6px; }
          .share-body strong { color: #F1F5F9; }
          .share-body p { margin-bottom: 14px; }
          .share-footer {
            text-align: center;
            padding: 32px 24px;
            border-top: 1px solid #1A1C1F;
            color: #4A4F58;
            font-size: 0.8rem;
          }
          .share-footer a { color: #6B7280; text-decoration: none; }
          .share-footer a:hover { color: #9CA3AF; }
          @media (max-width: 600px) {
            .share-content { padding: 32px 16px 60px; }
            .share-title { font-size: 1.3rem; }
          }
        </style>
      </head>
      <body>
        <header class="share-header">
          <a href="/" class="share-logo">Dokuvo</a>
          <a href="/app" class="share-cta">Selbst ausprobieren</a>
        </header>
        <main class="share-content">
          <h1 class="share-title">${data.title}</h1>
          <div class="share-meta">Erstellt am ${date} mit Dokuvo</div>
          <div class="share-body">${data.content}</div>
        </main>
        <footer class="share-footer">
          <p>Erstellt mit <a href="/">Dokuvo</a> — Komplexe Dokumente einfach verstehen</p>
          <p style="margin-top:8px;">Dokuvo ist kein Ersatz für rechtliche, medizinische oder steuerliche Beratung.</p>
        </footer>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Fehler beim Laden der Erklärung');
  }
});

// ── Dokumenten-Ordner ────────────────────────────────────────────────────────
// Ordner auflisten
app.get('/folders/:user_id', verifyUser, async (req, res) => {
  try {
    const { data } = await supabase
      .from('folders')
      .select('id, name, created_at')
      .eq('user_id', req.params.user_id)
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ordner erstellen
app.post('/folders', verifyUser, async (req, res) => {
  const { user_id, name } = req.body;
  try {
    const { data, error } = await supabase
      .from('folders')
      .insert({ user_id, name })
      .select('id, name, created_at')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ordner umbenennen
app.put('/folders/:id', verifyUser, async (req, res) => {
  const { name, user_id } = req.body;
  try {
    await supabase.from('folders').update({ name }).eq('id', req.params.id).eq('user_id', user_id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ordner löschen
app.delete('/folders/:id', verifyUser, async (req, res) => {
  const { user_id } = req.body;
  try {
    await supabase.from('folders').delete().eq('id', req.params.id).eq('user_id', user_id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Chat einem Ordner zuweisen
app.post('/folders/assign', verifyUser, async (req, res) => {
  const { user_id, session_id, folder_id } = req.body;
  try {
    await supabase.from('chat_titles').upsert(
      { user_id, session_id, folder_id },
      { onConflict: 'session_id' }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Chats in einem Ordner laden (mit Kontext)
app.get('/folders/:folder_id/chats/:user_id', verifyUser, async (req, res) => {
  try {
    const { data: titles } = await supabase
      .from('chat_titles')
      .select('session_id, title')
      .eq('user_id', req.params.user_id)
      .eq('folder_id', req.params.folder_id);

    if (!titles || !titles.length) return res.json([]);

    const sessionIds = titles.map(t => t.session_id);
    const titleMap = {};
    titles.forEach(t => { titleMap[t.session_id] = t.title; });

    const { data: chats } = await supabase
      .from('chats')
      .select('session_id, message, created_at')
      .eq('user_id', req.params.user_id)
      .in('session_id', sessionIds)
      .eq('role', 'user')
      .order('created_at', { ascending: false });

    const sessions = {};
    (chats || []).forEach(row => {
      if (!sessions[row.session_id]) {
        sessions[row.session_id] = {
          session_id: row.session_id,
          title: titleMap[row.session_id] || row.message.substring(0, 60),
          created_at: row.created_at
        };
      }
    });

    res.json(Object.values(sessions));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fristen-Erinnerungen ─────────────────────────────────────────────────────
async function sendReminderEmail(email, title, due_date, description) {
  const datumFormatiert = new Date(due_date + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  await axios.post('https://api.resend.com/emails', {
    from: 'Dokuvo <noreply@eli10.app>',
    to: email,
    subject: `Erinnerung: ${title}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;padding:32px 28px;">
        <h2 style="color:#3B82F6;margin-top:0;">Frist-Erinnerung</h2>
        <p>Wir erinnern dich an eine bevorstehende Frist:</p>
        <div style="background:#f4f4f5;border-left:3px solid #3B82F6;border-radius:8px;padding:16px 18px;margin:20px 0;">
          <div style="font-weight:600;font-size:1rem;">${title}</div>
          ${description ? `<div style="color:#6b7280;font-size:0.9rem;margin-top:6px;">${description}</div>` : ''}
          <div style="color:#d97706;font-size:0.85rem;margin-top:10px;">Fälligkeitsdatum: <strong>${datumFormatiert}</strong></div>
        </div>
        <p style="color:#6b7280;font-size:0.85rem;">Diese Erinnerung wurde in Dokuvo gesetzt.</p>
      </div>
    `
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
}

// Erinnerung erstellen
app.post('/reminders', verifyUser, async (req, res) => {
  const { user_id, title, due_date, description, email } = req.body;
  if (!user_id || !title || !due_date || !email) return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  try {
    const { data, error } = await supabase
      .from('reminders')
      .insert({ user_id, title, due_date, description, email, notified: false })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // E-Mail sofort schicken wenn Datum heute ist
    const today = new Date().toISOString().split('T')[0];
    if (due_date === today) {
      await sendReminderEmail(email, title, due_date, description);
      await supabase.from('reminders').update({ notified: true }).eq('id', data.id);
    }

    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Erinnerungen laden
app.get('/reminders/:user_id', verifyUser, async (req, res) => {
  try {
    const { data } = await supabase
      .from('reminders')
      .select('*')
      .eq('user_id', req.params.user_id)
      .order('due_date', { ascending: true });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Erinnerung löschen
app.delete('/reminders/:id', verifyUser, async (req, res) => {
  const { user_id } = req.body;
  try {
    await supabase.from('reminders').delete().eq('id', req.params.id).eq('user_id', user_id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cron-Endpoint: fällige Erinnerungen versenden — täglich 07:00 UTC via Vercel Cron
app.post('/reminders/notify', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const today = new Date().toISOString().split('T')[0];
  try {
    const { data: due } = await supabase
      .from('reminders')
      .select('*')
      .lte('due_date', today)
      .eq('notified', false);
    for (const r of (due || [])) {
      try {
        await sendReminderEmail(r.email, r.title, r.due_date, r.description);
        await supabase.from('reminders').update({ notified: true }).eq('id', r.id);
      } catch(e) { console.error('E-Mail Fehler für Reminder', r.id, e.message); }
    }
    res.json({ notified: (due || []).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Team-Workspace ───────────────────────────────────────────────────────────

// Team erstellen
app.post('/teams', verifyUser, async (req, res) => {
  const { user_id, name } = req.body;
  if (!name) return res.status(400).json({ error: 'Teamname fehlt' });
  try {
    const { data: team, error } = await supabase
      .from('teams')
      .insert({ name, owner_id: user_id })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    await supabase.from('team_members').insert({ team_id: team.id, user_id, role: 'owner' });
    res.json(team);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Teams des Users laden
app.get('/teams/:user_id', verifyUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('team_members')
      .select('role, teams(id, name, owner_id, created_at)')
      .eq('user_id', req.params.user_id);
    if (error) return res.status(500).json({ error: error.message });
    const teams = (data || []).map(d => ({ ...d.teams, role: d.role }));
    res.json(teams);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mitglied per E-Mail einladen
app.post('/teams/:id/invite', verifyUser, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-Mail fehlt' });
  try {
    // User per E-Mail finden
    const { data: users } = await supabase.auth.admin.listUsers();
    const found = users?.users?.find(u => u.email === email);
    if (!found) return res.status(404).json({ error: 'Kein Nutzer mit dieser E-Mail gefunden' });

    // Prüfen ob schon Mitglied
    const { data: existing } = await supabase.from('team_members')
      .select('id').eq('team_id', req.params.id).eq('user_id', found.id).single();
    if (existing) return res.status(409).json({ error: 'Nutzer ist bereits Mitglied' });

    await supabase.from('team_members').insert({ team_id: req.params.id, user_id: found.id, role: 'member' });
    res.json({ success: true, email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Chat-Session mit Team teilen
app.post('/teams/:id/share', verifyUser, async (req, res) => {
  const { user_id, session_id, note } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id fehlt' });
  try {
    // Prüfen ob Mitglied
    const { data: member } = await supabase.from('team_members')
      .select('id').eq('team_id', req.params.id).eq('user_id', user_id).single();
    if (!member) return res.status(403).json({ error: 'Kein Mitglied dieses Teams' });

    const { data, error } = await supabase.from('team_shares')
      .insert({ team_id: req.params.id, session_id, shared_by: user_id, note: note || null })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Geteilte Sessions im Team laden
app.get('/teams/:id/shared', verifyUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('team_shares')
      .select('id, session_id, note, shared_by, created_at')
      .eq('team_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    // Titel aus chat_titles laden
    const sessionIds = (data || []).map(d => d.session_id);
    const { data: titles } = sessionIds.length
      ? await supabase.from('chat_titles').select('session_id, title').in('session_id', sessionIds)
      : { data: [] };
    const titleMap = {};
    (titles || []).forEach(t => { titleMap[t.session_id] = t.title; });

    const result = (data || []).map(d => ({ ...d, title: titleMap[d.session_id] || d.session_id }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(3000, () => {
  console.log('Dokuvo läuft auf Port 3000');
});

module.exports = app;