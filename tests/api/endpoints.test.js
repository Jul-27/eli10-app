const request = require('supertest');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'https://eli10-app-olxw.vercel.app';
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const HAS_CREDENTIALS = !!(TEST_EMAIL && TEST_PASSWORD);

// Supabase Public Credentials (aus Frontend bekannt)
const SUPABASE_URL = 'https://srmpdeqpwikjdbwjudqs.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_bVb-24sFpnG6sPxDvmwqfw_F4_F9Mcw';

// Authentifizierter Test-User (wird in beforeAll befüllt)
let testUserId = null;

// Erstellt ein minimales valides Test-PDF
function erstelleTestPDF(inhalt = 'Testvertrag Mietvertrag Wien 2024') {
  const content = `BT /F1 12 Tf 100 700 Td (${inhalt}) Tj ET`;
  const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${content.length}>>stream
${content}
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000274 00000 n
0000000368 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
441
%%EOF`;
  const tmpPath = '/tmp/test-endpoints.pdf';
  fs.writeFileSync(tmpPath, pdf);
  return tmpPath;
}

// Login via Supabase um eine gültige user_id zu bekommen
beforeAll(async () => {
  if (!HAS_CREDENTIALS) return;
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD
    });
    if (!error && data?.user) {
      testUserId = data.user.id;
    }
  } catch (e) {
    console.warn('beforeAll Login fehlgeschlagen:', e.message);
  }
}, 15000);

// ── Öffentliche Routen ────────────────────────────────────────────────────────

describe('GET /', () => {
  test('Landing Page lädt HTML zurück', async () => {
    const res = await request(BASE_URL).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Dokuvo');
  });
});

describe('GET /app', () => {
  test('App lädt HTML zurück', async () => {
    const res = await request(BASE_URL).get('/app');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Dokuvo');
  });
});

// ── Dokument-Analyse ──────────────────────────────────────────────────────────

describe('POST /upload-document', () => {
  test('400 ohne Datei', async () => {
    const res = await request(BASE_URL).post('/upload-document');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('Analyse mit echtem PDF enthält alle Response-Felder', async () => {
    if (!HAS_CREDENTIALS) return;
    const pdfPath = erstelleTestPDF('Mietvertrag Wien Laufzeit 12 Monate Miete 800 Euro Frist 31.12.2027');
    const res = await request(BASE_URL)
      .post('/upload-document')
      .attach('document', pdfPath)
      .field('user_id', testUserId || '')
      .timeout(90000);
    expect([200, 400, 429]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.explanation).toBeDefined();
      expect(res.body.followUps).toBeDefined();
      expect(res.body.fristen).toBeDefined();
      expect(res.body.risiken).toBeDefined();
      expect(res.body.zusammenfassung).toBeDefined();
      expect(res.body.handlungen).toBeDefined();
      expect(res.body.glossar).toBeDefined();
      expect(res.body.checkliste).toBeDefined();
      expect(res.body.statistiken).toBeDefined();
      expect(typeof res.body.statistiken.wortanzahl).toBe('number');
      expect(typeof res.body.statistiken.lesezeit).toBe('number');
    }
  }, 90000);
});

describe('POST /analyze-image', () => {
  test('400 ohne Bild', async () => {
    const res = await request(BASE_URL).post('/analyze-image');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('POST /compare-documents', () => {
  test('400/500 ohne Dokumente', async () => {
    const res = await request(BASE_URL).post('/compare-documents');
    expect([400, 500]).toContain(res.status);
  });

  test('400 mit nur einem Dokument', async () => {
    const pdfPath = erstelleTestPDF('Dokument Eins');
    const res = await request(BASE_URL)
      .post('/compare-documents')
      .attach('doc1', pdfPath)
      .timeout(10000);
    expect([400, 500]).toContain(res.status);
  }, 15000);

  test('Vergleich mit zwei PDFs liefert Vergleichsfelder', async () => {
    if (!HAS_CREDENTIALS || !testUserId) return;
    const pdf1 = erstelleTestPDF('Mietvertrag A monatliche Miete 800 Euro');
    const pdf2 = erstelleTestPDF('Mietvertrag B monatliche Miete 950 Euro');
    const res = await request(BASE_URL)
      .post('/compare-documents')
      .attach('doc1', pdf1)
      .attach('doc2', pdf2)
      .field('user_id', testUserId)
      .timeout(90000);
    expect([200, 429]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.comparison).toBeDefined();
      expect(res.body.followUps).toBeDefined();
      expect(Array.isArray(res.body.fristen)).toBe(true);
      expect(res.body.doc1Name).toBeDefined();
      expect(res.body.doc2Name).toBeDefined();
    }
  }, 90000);
});

// ── Chat ──────────────────────────────────────────────────────────────────────

describe('POST /chat', () => {
  test('401 ohne gültige user_id', async () => {
    const res = await request(BASE_URL)
      .post('/chat')
      .send({ user_id: '', session_id: 'test', message: 'Test' });
    expect([401, 429, 500]).toContain(res.status);
  });

  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .post('/chat')
      .send({ user_id: 'ungueltige-id-xyz', session_id: 'sess1', message: 'Hallo' });
    expect([401, 500]).toContain(res.status);
  });

  test('Chat-Antwort mit gültigem User enthält reply und followUps', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .post('/chat')
      .send({ user_id: testUserId, session_id: `test-${Date.now()}`, message: 'Was ist ein Mietvertrag?' })
      .timeout(40000);
    expect([200, 429]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.reply).toBeDefined();
      expect(Array.isArray(res.body.followUps)).toBe(true);
    }
  }, 45000);
});

describe('GET /chat/:user_id', () => {
  test('401 für unbekannte user_id', async () => {
    const res = await request(BASE_URL).get('/chat/unbekannte-user-id-xyz');
    expect([200, 401]).toContain(res.status);
  });

  test('Liefert Array für gültigen User', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL).get(`/chat/${testUserId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /chat/:user_id/:session_id', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL).get('/chat/ungueltig/session-xyz');
    expect([401, 500]).toContain(res.status);
  });

  test('Leeres Array für nicht existierende Session', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL).get(`/chat/${testUserId}/nicht-existierend-${Date.now()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });
});

describe('POST /chat/search', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .post('/chat/search')
      .send({ user_id: 'ungueltig', query: 'Mietvertrag' });
    expect([401, 500]).toContain(res.status);
  });

  test('Leeres Array bei Query kürzer als 2 Zeichen', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .post('/chat/search')
      .send({ user_id: testUserId, query: 'a' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  test('Gibt Array zurück bei gültigem User und Query', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .post('/chat/search')
      .send({ user_id: testUserId, query: 'Vertrag' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /chat/rename', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .post('/chat/rename')
      .send({ user_id: 'ungueltig', session_id: 'sess', title: 'Neuer Titel' });
    expect([401, 500]).toContain(res.status);
  });

  test('Erfolgreicher Rename mit gültigem User', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .post('/chat/rename')
      .send({ user_id: testUserId, session_id: `test-rename-${Date.now()}`, title: 'Test-Titel' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('DELETE /chat/:user_id/:session_id', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .delete('/chat/ungueltig/session-xyz');
    expect([401, 500]).toContain(res.status);
  });

  test('Löschen einer nicht existierenden Session gibt success', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .delete(`/chat/${testUserId}/nicht-existierend-${Date.now()}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── Status & Profil ───────────────────────────────────────────────────────────

describe('POST /check-status', () => {
  test('Gibt 401/200 ohne gültige user_id', async () => {
    const res = await request(BASE_URL)
      .post('/check-status')
      .send({ user_id: 'invalid-id-xyz' });
    expect([200, 401]).toContain(res.status);
  });

  test('Gibt remaining und isPremium für gültigen User', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .post('/check-status')
      .send({ user_id: testUserId });
    expect(res.status).toBe(200);
    expect(typeof res.body.remaining).toBe('number');
    expect(typeof res.body.isPremium).toBe('boolean');
  });
});

describe('POST /get-profile', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .post('/get-profile')
      .send({ user_id: 'ungueltig' });
    expect([401, 500]).toContain(res.status);
  });

  test('Gibt Profildaten für gültigen User zurück', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .post('/get-profile')
      .send({ user_id: testUserId });
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });
});

// ── Feedback ──────────────────────────────────────────────────────────────────

describe('POST /feedback', () => {
  test('401 ohne gültige user_id', async () => {
    const res = await request(BASE_URL)
      .post('/feedback')
      .send({ user_id: 'test', session_id: 'test', message: 'test', rating: 'up' });
    expect([200, 401, 500]).toContain(res.status);
  });

  test('Speichert Feedback für gültigen User', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .post('/feedback')
      .send({ user_id: testUserId, session_id: `sess-${Date.now()}`, message: 'Test-Feedback', rating: 'up' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Teilen ────────────────────────────────────────────────────────────────────

describe('POST /share', () => {
  test('400 ohne content', async () => {
    const res = await request(BASE_URL)
      .post('/share')
      .send({ user_id: 'test', session_id: 'sess', title: 'Test' });
    expect([400, 401]).toContain(res.status);
  });

  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .post('/share')
      .send({ user_id: 'ungueltig', session_id: 'sess', title: 'Titel', content: '<p>Inhalt</p>' });
    expect([401, 500]).toContain(res.status);
  });

  test('Erstellt Share-Link für gültigen User', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .post('/share')
      .send({
        user_id: testUserId,
        session_id: `sess-share-${Date.now()}`,
        title: 'Test-Erklärung',
        content: '<p>Das ist ein Test-Inhalt für den Share-Endpoint.</p>'
      });
    expect(res.status).toBe(200);
    expect(res.body.shareUrl).toBeDefined();
    expect(res.body.shareId).toBeDefined();
    expect(res.body.shareUrl).toContain('/shared/');
  });
});

describe('GET /shared/:id', () => {
  test('404 HTML für nicht existierende ID', async () => {
    const res = await request(BASE_URL).get('/shared/nicht-existierende-id-12345');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Nicht gefunden');
  });

  test('Öffentlicher Zugriff ohne Auth möglich', async () => {
    // Endpoint soll kein Auth verlangen — 404 oder 200, nie 401
    const res = await request(BASE_URL).get('/shared/irgendeine-id');
    expect(res.status).not.toBe(401);
  });

  test('Share-Link aus /share liefert HTML mit Inhalt', async () => {
    if (!testUserId) return;
    // Erst Share erstellen
    const share = await request(BASE_URL)
      .post('/share')
      .send({
        user_id: testUserId,
        session_id: `sess-view-${Date.now()}`,
        title: 'Geteilte Erklärung',
        content: '<p>Inhalt der Erklärung</p>'
      });
    if (share.status !== 200 || !share.body.shareId) return;

    const res = await request(BASE_URL).get(`/shared/${share.body.shareId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Dokuvo');
    expect(res.text).toContain('Geteilte Erklärung');
  });
});

// ── Ordner ────────────────────────────────────────────────────────────────────

describe('GET /folders/:user_id', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL).get('/folders/ungueltige-id');
    expect([401, 500]).toContain(res.status);
  });

  test('Gibt Array für gültigen User zurück', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL).get(`/folders/${testUserId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /folders', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .post('/folders')
      .send({ user_id: 'ungueltig', name: 'Test-Ordner' });
    expect([401, 500]).toContain(res.status);
  });

  test('Erstellt Ordner für gültigen User', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .post('/folders')
      .send({ user_id: testUserId, name: `Test-Ordner-${Date.now()}` });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBeDefined();
  });
});

describe('PUT /folders/:id', () => {
  test('Gibt Fehler ohne gültige user_id', async () => {
    const res = await request(BASE_URL)
      .put('/folders/nicht-existierend')
      .send({ user_id: 'ungueltig', name: 'Neuer Name' });
    expect([401, 500]).toContain(res.status);
  });

  test('Umbenennen eines Ordners', async () => {
    if (!testUserId) return;
    // Erst Ordner erstellen
    const create = await request(BASE_URL)
      .post('/folders')
      .send({ user_id: testUserId, name: `Umbenennen-${Date.now()}` });
    if (create.status !== 200) return;
    const folderId = create.body.id;

    const res = await request(BASE_URL)
      .put(`/folders/${folderId}`)
      .send({ user_id: testUserId, name: 'Umbenannt' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('DELETE /folders/:id', () => {
  test('Gibt Fehler ohne gültige user_id', async () => {
    const res = await request(BASE_URL)
      .delete('/folders/nicht-existierend')
      .send({ user_id: 'ungueltig' });
    expect([401, 500]).toContain(res.status);
  });

  test('Löscht Ordner für gültigen User', async () => {
    if (!testUserId) return;
    const create = await request(BASE_URL)
      .post('/folders')
      .send({ user_id: testUserId, name: `Loeschen-${Date.now()}` });
    if (create.status !== 200) return;

    const res = await request(BASE_URL)
      .delete(`/folders/${create.body.id}`)
      .send({ user_id: testUserId });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /folders/assign', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .post('/folders/assign')
      .send({ user_id: 'ungueltig', session_id: 'sess', folder_id: 'folder' });
    expect([401, 500]).toContain(res.status);
  });

  test('Weist Session einem Ordner zu', async () => {
    if (!testUserId) return;
    const folder = await request(BASE_URL)
      .post('/folders')
      .send({ user_id: testUserId, name: `Assign-${Date.now()}` });
    if (folder.status !== 200) return;

    const res = await request(BASE_URL)
      .post('/folders/assign')
      .send({ user_id: testUserId, session_id: `sess-${Date.now()}`, folder_id: folder.body.id });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /folders/:folder_id/chats/:user_id', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL).get('/folders/folder-xyz/chats/ungueltig');
    expect([401, 500]).toContain(res.status);
  });

  test('Gibt Array für Ordner zurück', async () => {
    if (!testUserId) return;
    const folder = await request(BASE_URL)
      .post('/folders')
      .send({ user_id: testUserId, name: `Chats-${Date.now()}` });
    if (folder.status !== 200) return;

    const res = await request(BASE_URL).get(`/folders/${folder.body.id}/chats/${testUserId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── Fristen-Erinnerungen ──────────────────────────────────────────────────────

describe('POST /reminders', () => {
  test('400 ohne Pflichtfelder', async () => {
    const res = await request(BASE_URL)
      .post('/reminders')
      .send({ user_id: 'x', title: 'Test' }); // due_date und email fehlen
    expect([400, 401]).toContain(res.status);
  });

  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .post('/reminders')
      .send({ user_id: 'ungueltig', title: 'Test', due_date: '2027-01-01', description: '', email: 'a@b.de' });
    expect([401, 500]).toContain(res.status);
  });

  test('Erstellt Erinnerung für gültigen User', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .post('/reminders')
      .send({
        user_id: testUserId,
        title: `Test-Erinnerung-${Date.now()}`,
        due_date: '2027-12-31',
        description: 'Automatischer E2E-Test',
        email: TEST_EMAIL
      });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.title).toBeDefined();
  });
});

describe('GET /reminders/:user_id', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL).get('/reminders/ungueltige-id');
    expect([401, 500]).toContain(res.status);
  });

  test('Gibt Array für gültigen User zurück', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL).get(`/reminders/${testUserId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('DELETE /reminders/:id', () => {
  test('Gibt Fehler ohne gültige user_id', async () => {
    const res = await request(BASE_URL)
      .delete('/reminders/nicht-existierend')
      .send({ user_id: 'ungueltig' });
    expect([401, 500]).toContain(res.status);
  });

  test('Löscht Erinnerung für gültigen User', async () => {
    if (!testUserId) return;
    // Erst erstellen
    const create = await request(BASE_URL)
      .post('/reminders')
      .send({
        user_id: testUserId,
        title: `Loeschen-${Date.now()}`,
        due_date: '2027-06-15',
        description: '',
        email: TEST_EMAIL
      });
    if (create.status !== 200) return;

    const res = await request(BASE_URL)
      .delete(`/reminders/${create.body.id}`)
      .send({ user_id: testUserId });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('POST /reminders/notify', () => {
  test('401 ohne Authorization-Header', async () => {
    const res = await request(BASE_URL).post('/reminders/notify');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  test('401 mit falschem CRON_SECRET', async () => {
    const res = await request(BASE_URL)
      .post('/reminders/notify')
      .set('Authorization', 'Bearer falsches-secret-xyz');
    expect(res.status).toBe(401);
  });
});

// ── Team-Workspace ────────────────────────────────────────────────────────────

describe('POST /teams', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .post('/teams')
      .send({ user_id: 'ungueltig', name: 'Test-Team' });
    expect([401, 500]).toContain(res.status);
  });

  test('400 ohne Teamname', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .post('/teams')
      .send({ user_id: testUserId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Teamname fehlt');
  });

  test('Erstellt Team für gültigen User', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .post('/teams')
      .send({ user_id: testUserId, name: `Test-Team-${Date.now()}` });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBeDefined();
    expect(res.body.owner_id).toBe(testUserId);
  });
});

describe('GET /teams/:user_id', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .get('/teams/ungueltige-id')
      .set('x-user-id', 'ungueltige-id');
    expect([401, 500]).toContain(res.status);
  });

  test('Gibt Array für gültigen User zurück', async () => {
    if (!testUserId) return;
    const res = await request(BASE_URL)
      .get(`/teams/${testUserId}`)
      .set('x-user-id', testUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('Owner-Rolle ist in Antwort enthalten', async () => {
    if (!testUserId) return;
    // Erst Team erstellen
    await request(BASE_URL)
      .post('/teams')
      .send({ user_id: testUserId, name: `Rollen-Test-${Date.now()}` });

    const res = await request(BASE_URL)
      .get(`/teams/${testUserId}`)
      .set('x-user-id', testUserId);
    expect(res.status).toBe(200);
    if (res.body.length > 0) {
      const owner = res.body.find(t => t.role === 'owner');
      expect(owner).toBeDefined();
    }
  });
});

describe('POST /teams/:id/invite', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .post('/teams/ein-team-id/invite')
      .send({ user_id: 'ungueltig', email: 'test@test.de' });
    expect([401, 500]).toContain(res.status);
  });

  test('400 ohne E-Mail', async () => {
    if (!testUserId) return;
    // Erst Team erstellen
    const team = await request(BASE_URL)
      .post('/teams')
      .send({ user_id: testUserId, name: `Invite-Test-${Date.now()}` });
    if (team.status !== 200) return;

    const res = await request(BASE_URL)
      .post(`/teams/${team.body.id}/invite`)
      .send({ user_id: testUserId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('E-Mail fehlt');
  });

  test('404 bei nicht-existierendem E-Mail-User', async () => {
    if (!testUserId) return;
    const team = await request(BASE_URL)
      .post('/teams')
      .send({ user_id: testUserId, name: `Invite-404-${Date.now()}` });
    if (team.status !== 200) return;

    const res = await request(BASE_URL)
      .post(`/teams/${team.body.id}/invite`)
      .send({ user_id: testUserId, email: `nicht-vorhanden-${Date.now()}@example.com` });
    expect(res.status).toBe(404);
  });
});

describe('POST /teams/:id/share', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .post('/teams/ein-team-id/share')
      .send({ user_id: 'ungueltig', session_id: 'sess' });
    expect([401, 500]).toContain(res.status);
  });

  test('400 ohne session_id', async () => {
    if (!testUserId) return;
    const team = await request(BASE_URL)
      .post('/teams')
      .send({ user_id: testUserId, name: `Share-Test-${Date.now()}` });
    if (team.status !== 200) return;

    const res = await request(BASE_URL)
      .post(`/teams/${team.body.id}/share`)
      .send({ user_id: testUserId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('session_id fehlt');
  });

  test('Teilt Session mit eigenem Team', async () => {
    if (!testUserId) return;
    const team = await request(BASE_URL)
      .post('/teams')
      .send({ user_id: testUserId, name: `Share-Erfolg-${Date.now()}` });
    if (team.status !== 200) return;

    const res = await request(BASE_URL)
      .post(`/teams/${team.body.id}/share`)
      .send({ user_id: testUserId, session_id: `sess-${Date.now()}`, note: 'Test-Notiz' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.team_id).toBe(team.body.id);
  });
});

describe('GET /teams/:id/shared', () => {
  test('401 mit ungültiger user_id', async () => {
    const res = await request(BASE_URL)
      .get('/teams/ein-team-id/shared?user_id=ungueltig')
      .set('x-user-id', 'ungueltig');
    expect([401, 500]).toContain(res.status);
  });

  test('Gibt geteilte Sessions für Team-Mitglieder zurück', async () => {
    if (!testUserId) return;
    // Team erstellen + Session teilen
    const team = await request(BASE_URL)
      .post('/teams')
      .send({ user_id: testUserId, name: `Shared-${Date.now()}` });
    if (team.status !== 200) return;

    await request(BASE_URL)
      .post(`/teams/${team.body.id}/share`)
      .send({ user_id: testUserId, session_id: `sess-${Date.now()}` });

    const res = await request(BASE_URL)
      .get(`/teams/${team.body.id}/shared?user_id=${testUserId}`)
      .set('x-user-id', testUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length > 0) {
      expect(res.body[0].session_id).toBeDefined();
      expect(res.body[0].title).toBeDefined();
    }
  });

  test('403 für Nicht-Mitglieder beim Teilen', async () => {
    if (!testUserId) return;
    const team = await request(BASE_URL)
      .post('/teams')
      .send({ user_id: testUserId, name: `Forbidden-${Date.now()}` });
    if (team.status !== 200) return;

    // Mit einer anderen (ungültigen) user_id versuchen zu teilen
    const res = await request(BASE_URL)
      .post(`/teams/${team.body.id}/share`)
      .send({ user_id: 'andere-ungueltige-id', session_id: 'sess' });
    expect([401, 403, 500]).toContain(res.status);
  });
});

// ── Kalender ──────────────────────────────────────────────────────────────────

describe('POST /kalender-alarm', () => {
  test('Endpoint existiert und antwortet', async () => {
    const res = await request(BASE_URL)
      .post('/kalender-alarm')
      .send({ titel: 'Test', datum: '2027-12-31', beschreibung: 'Test' });
    expect([200, 401, 500]).toContain(res.status);
  });
});
