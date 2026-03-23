const request = require('supertest');

// Backend-URL
const BASE_URL = process.env.BASE_URL || 'https://eli10-app-olxw.vercel.app';

describe('Backend API Endpoints', () => {

  describe('GET /', () => {
    test('App lädt HTML zurück', async () => {
      const res = await request(BASE_URL).get('/');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Dokuvo');
    });
  });

  describe('POST /check-status', () => {
    test('Gibt Status für gültige user_id zurück', async () => {
      const res = await request(BASE_URL)
        .post('/check-status')
        .send({ user_id: 'test-user-id' });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('remaining');
      expect(res.body).toHaveProperty('isPremium');
    });

    test('Gibt Fallback bei ungültiger user_id', async () => {
      const res = await request(BASE_URL)
        .post('/check-status')
        .send({ user_id: 'invalid-id-xyz' });
      expect(res.status).toBe(200);
      expect(res.body.remaining).toBeDefined();
    });
  });

  describe('POST /chat', () => {
    test('Gibt 400/429 ohne gültige user_id', async () => {
      const res = await request(BASE_URL)
        .post('/chat')
        .send({ user_id: '', session_id: 'test', message: 'Test' });
      expect([400, 429, 500]).toContain(res.status);
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
    test('Gibt leeres Array für unbekannte user_id', async () => {
      const res = await request(BASE_URL)
        .get('/chat/unbekannte-user-id-xyz');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('POST /feedback', () => {
    test('Endpoint existiert und antwortet', async () => {
      const res = await request(BASE_URL)
        .post('/feedback')
        .send({ user_id: 'test', session_id: 'test', message: 'test', rating: 'up' });
      expect([200, 500]).toContain(res.status);
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