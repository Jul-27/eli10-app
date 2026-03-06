const express = require('express');
const Groq = require('groq-sdk');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.json());

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  res.send(fs.readFileSync(htmlPath, 'utf8'));
});

app.post('/explain', async (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'Kein Text angegeben' });
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
    res.json({ explanation });

  } catch (error) {
    console.error('Groq Fehler:', error.message);
    res.status(500).json({ error: 'KI konnte den Text nicht verarbeiten.' });
  }
});

app.listen(3000, () => {
  console.log('ELI10 läuft auf Port 3000');
});

module.exports = app;
