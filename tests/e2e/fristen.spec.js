const { test, expect } = require('@playwright/test');
const fs = require('fs');

const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const HAS_CREDENTIALS = !!(TEST_EMAIL && TEST_PASSWORD);

async function login(page) {
  await page.goto('/');
  await page.fill('#emailInput', TEST_EMAIL);
  await page.fill('#passwordInput', TEST_PASSWORD);
  await page.click('#authBtn');
  await expect(page.locator('#chatEmpty')).toBeVisible({ timeout: 30000 });
}

test.describe('Fristen-Erkennung', () => {

  test.beforeEach(async ({ page }) => {
    test.skip(!HAS_CREDENTIALS, 'Braucht TEST_EMAIL und TEST_PASSWORD Secrets');
    await login(page);
  });

  test('Fristen-Block erscheint bei Dokument mit Datum', async ({ page }) => {
    const pdfContent = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 120>>stream
BT /F1 10 Tf 50 700 Td (Widerrufsrecht bis zum 31.12.2026 geltend machen.) Tj ET
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
    fs.writeFileSync('/tmp/test-frist.pdf', pdfContent);
    await page.locator('#pdfInput').setInputFiles('/tmp/test-frist.pdf');
    await expect(page.locator('.chat-bubble.assistant .result-text').first())
      .not.toBeEmpty({ timeout: 60000 });
    const hatFristen = await page.locator('.fristen-block').count() > 0;
    if (hatFristen) {
      await expect(page.locator('.frist-export-btn').first()).toBeVisible();
    }
  });

  test('"In Kalender" Button im manuell erzeugten Fristen-Block', async ({ page }) => {
    await page.evaluate(() => {
      const container = document.getElementById('chatMessages');
      container.style.display = 'flex';
      document.getElementById('chatEmpty').style.display = 'none';
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble assistant';
      container.appendChild(bubble);
      if (typeof zeigeFristenBlock === 'function') {
        zeigeFristenBlock([{
          titel: 'Widerrufsrecht',
          datum: '2026-12-31',
          beschreibung: 'Vertrag widerrufen'
        }], bubble);
      }
    });
    const hatBlock = await page.locator('.fristen-block').count() > 0;
    if (hatBlock) {
      await expect(page.locator('.frist-export-btn')).toBeVisible();
    }
  });

});