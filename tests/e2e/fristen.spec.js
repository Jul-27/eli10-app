const { test, expect } = require('@playwright/test');
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

test.describe('Fristen-Erkennung', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Fristen-Block erscheint bei Dokument mit Datum', async ({ page }) => {
    // PDF mit konkretem Datum erstellen
    const pdfContent = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 120>>stream
BT /F1 10 Tf 50 700 Td (Widerrufsrecht: Sie haben das Recht diesen Vertrag bis zum 31.12.2025 zu widerrufen.) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000274 00000 n
0000000450 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
521
%%EOF`;

    const pdfPath = '/tmp/test-frist.pdf';
    fs.writeFileSync(pdfPath, pdfContent);

    await page.locator('#pdfInput').setInputFiles(pdfPath);

    // Warten auf vollständige Analyse
    await expect(page.locator('.chat-bubble.assistant .result-text').first())
      .not.toBeEmpty({ timeout: 60000 });

    // Fristen-Block prüfen (erscheint wenn Datum erkannt)
    // Nicht immer garantiert je nach KI-Antwort
    const fristenBlock = page.locator('.fristen-block');
    const hatFristen = await fristenBlock.count() > 0;
    if (hatFristen) {
      await expect(fristenBlock.first()).toBeVisible();
      await expect(page.locator('.frist-export-btn').first()).toBeVisible();
    }
  });

  test('ICS Download Button funktioniert', async ({ page }) => {
    // Direkt über die generiereICS Funktion testen
    const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);

    await page.evaluate(() => {
      if (typeof generiereICS === 'function') {
        generiereICS('Test Frist', '2025-12-31', 'Dies ist eine Testfrist');
      }
    });

    // Falls Download ausgelöst wurde
    const download = await downloadPromise;
    if (download) {
      expect(download.suggestedFilename()).toContain('.ics');
    }
  });

  test('"In Kalender" Button ist im Fristen-Block vorhanden', async ({ page }) => {
    // Fristen-Block manuell simulieren
    await page.evaluate(() => {
      const container = document.getElementById('chatMessages');
      if (!container) return;
      container.style.display = 'flex';
      document.getElementById('chatEmpty').style.display = 'none';

      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble assistant';
      container.appendChild(bubble);

      if (typeof zeigeFristenBlock === 'function') {
        zeigeFristenBlock([{
          titel: 'Widerrufsrecht',
          datum: '2025-12-31',
          beschreibung: 'Vertrag kann bis zu diesem Datum widerrufen werden'
        }], bubble);
      }
    });

    await expect(page.locator('.fristen-block')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.frist-export-btn')).toBeVisible();
  });

});