const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const TEST_EMAIL = process.env.TEST_EMAIL || 'test@dokuvo.at';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'TestPassword123!';

async function login(page) {
  await page.goto('/');
  await page.fill('#emailInput', TEST_EMAIL);
  await page.fill('#passwordInput', TEST_PASSWORD);
  await page.click('#authBtn');
  await page.waitForSelector('#appScreen', { timeout: 10000 });
}

// Einfaches Test-PDF erstellen
function erstelleTestPDF() {
  const pdfPath = '/tmp/test-dokument.pdf';
  // Minimales gültiges PDF
  const minimalPDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 100 700 Td (Testvertrag Mietvertrag Wien 2024) Tj ET
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
  fs.writeFileSync(pdfPath, minimalPDF);
  return pdfPath;
}

test.describe('PDF & Foto Upload', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('PDF-Upload Button ist sichtbar', async ({ page }) => {
    await expect(page.locator('#pdfInput')).toBeAttached();
    await expect(page.locator('button:has-text("PDF hochladen")').first()).toBeVisible();
  });

  test('Foto-Upload Button ist sichtbar', async ({ page }) => {
    await expect(page.locator('#fotoInput')).toBeAttached();
    await expect(page.locator('button:has-text("Foto machen")').first()).toBeVisible();
  });

  test('Dokumente vergleichen Button öffnet Modal', async ({ page }) => {
    await page.click('button:has-text("Dokumente vergleichen")');
    await expect(page.locator('.vergleich-modal')).toBeVisible();
    await expect(page.locator('#slot1')).toBeVisible();
    await expect(page.locator('#slot2')).toBeVisible();
    await expect(page.locator('#vergleichStartBtn')).toBeDisabled();
    // Abbrechen
    await page.click('button:has-text("Abbrechen")');
    await expect(page.locator('.vergleich-modal')).not.toBeVisible();
  });

  test('PDF hochladen und Analyse erhalten', async ({ page }) => {
    const pdfPath = erstelleTestPDF();
    const fileInput = page.locator('#pdfInput');

    await fileInput.setInputFiles(pdfPath);

    // Loading erscheint
    await expect(page.locator('.chat-bubble.assistant').first()).toBeVisible({ timeout: 5000 });

    // Analyse erscheint (max. 60 Sekunden wegen Groq API)
    await expect(page.locator('.chat-bubble.assistant .result-text').first())
      .not.toBeEmpty({ timeout: 60000 });

    // Folgefragen erscheinen
    await expect(page.locator('.followup-chip').first()).toBeVisible({ timeout: 5000 });
  });

});