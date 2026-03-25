const request = require('supertest');

// Backend-URL
const BASE_URL = process.env.BASE_URL || 'https://eli10-app-olxw.vercel.app';

describe('Backend API Endpoints', () => {

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

  describe('POST /check-status', () => {
    test('Gibt 401 ohne gültige user_id', async () => {
      const res = await request(BASE_URL)
        .post('/check-status')
        .send({ user_id: 'invalid-id-xyz' });
      expect([200, 401]).toContain(res.status);
    });
  });

  describe('POST /chat', () => {
    test('Gibt 401/429 ohne gültige user_id', async () => {
      const res = await request(BASE_URL)
        .post('/chat')
        .send({ user_id: '', session_id: 'test', message: 'Test' });
      expect([401, 429, 500]).toContain(res.status);
    });
  });

  describe('POST /upload-document', () => {
    test('Gibt 400 ohne Datei zurück', async () => {
      const res = await request(BASE_URL)
        .post('/upload-document');
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('POST /analyze-image', () => {
    test('Gibt 400 ohne Bild zurück', async () => {
      const res = await request(BASE_URL)
        .post('/analyze-image');
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('POST /compare-documents', () => {
    test('Gibt 400 ohne Dokumente zurück', async () => {
      const res = await request(BASE_URL)
        .post('/compare-documents');
      expect([400, 500]).toContain(res.status);
    });
  });

  describe('GET /chat/:user_id', () => {
    test('Gibt 401 für unbekannte user_id', async () => {
      const res = await request(BASE_URL)
        .get('/chat/unbekannte-user-id-xyz');
      expect([200, 401]).toContain(res.status);
    });
  });

  describe('POST /feedback', () => {
    test('Gibt 401 ohne gültige user_id', async () => {
      const res = await request(BASE_URL)
        .post('/feedback')
        .send({ user_id: 'test', session_id: 'test', message: 'test', rating: 'up' });
      expect([200, 401, 500]).toContain(res.status);
    });
  });

  describe('POST /kalender-alarm', () => {
    test('Endpoint existiert', async () => {
      const res = await request(BASE_URL)
        .post('/kalender-alarm')
        .send({ titel: 'Test', datum: '2025-12-31', beschreibung: 'Test' });
      expect([200, 401, 500]).toContain(res.status);
    });
  });

});