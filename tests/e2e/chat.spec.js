const { test, expect } = require('@playwright/test');

const TEST_EMAIL = process.env.TEST_EMAIL || 'test@dokuvo.at';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'TestPassword123!';

// Hilfsfunktion: einloggen
async function login(page) {
  await page.goto('/');
  await page.fill('#emailInput', TEST_EMAIL);
  await page.fill('#passwordInput', TEST_PASSWORD);
  await page.click('#authBtn');
  await page.waitForSelector('#appScreen', { timeout: 10000 });
}

test.describe('Chat & Fragen stellen', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Chat-Empty-Screen wird nach Login angezeigt', async ({ page }) => {
    await expect(page.locator('#chatEmpty')).toBeVisible();
    await expect(page.locator('#chatInput')).toBeVisible();
  });

  test('Erklärungstiefe-Buttons sind klickbar', async ({ page }) => {
    const buttons = page.locator('.depth-step');
    await expect(buttons).toHaveCount(3);
    await buttons.nth(2).click(); // Experte
    await expect(buttons.nth(2)).toHaveClass(/active/);
    await buttons.nth(0).click(); // Einfach
    await expect(buttons.nth(0)).toHaveClass(/active/);
  });

  test('Frage stellen und Antwort erhalten', async ({ page }) => {
    await page.fill('#chatInput', 'Was ist eine Vollmacht?');
    await page.click('#sendBtn');

    // User-Bubble erscheint
    await expect(page.locator('.chat-bubble.user').first()).toContainText('Was ist eine Vollmacht?');

    // Assistent antwortet (max. 30 Sekunden)
    await expect(page.locator('.chat-bubble.assistant .result-text').first())
      .not.toBeEmpty({ timeout: 30000 });
  });

  test('Folgefragen-Chips erscheinen nach Antwort', async ({ page }) => {
    await page.fill('#chatInput', 'Was ist ein Mietvertrag?');
    await page.click('#sendBtn');
    await expect(page.locator('.followup-chip').first()).toBeVisible({ timeout: 30000 });
    const chips = page.locator('.followup-chip');
    await expect(chips).toHaveCount(3);
  });

  test('Folgefrage per Chip stellen', async ({ page }) => {
    await page.fill('#chatInput', 'Was ist ein Kredit?');
    await page.click('#sendBtn');
    await expect(page.locator('.followup-chip').first()).toBeVisible({ timeout: 30000 });
    await page.locator('.followup-chip').first().click();
    // Chips verschwinden nach Klick
    await expect(page.locator('.followup-chip').first()).not.toBeVisible({ timeout: 5000 });
    // Neue Antwort kommt
    await expect(page.locator('.chat-bubble.assistant').nth(1)).toBeVisible({ timeout: 30000 });
  });

  test('Neuer Chat Button setzt Chat zurück', async ({ page }) => {
    await page.fill('#chatInput', 'Test');
    await page.click('#sendBtn');
    await page.waitForSelector('.chat-bubble.user');
    await page.click('button:has-text("Neuer Chat"), button:has-text("+ Neu")');
    await expect(page.locator('#chatEmpty')).toBeVisible();
  });

  test('Feedback-Buttons erscheinen nach Antwort', async ({ page }) => {
    await page.fill('#chatInput', 'Was ist eine Bürgschaft?');
    await page.click('#sendBtn');
    await expect(page.locator('.feedback-row').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.feedback-btn').first()).toBeVisible();
  });

  test('PDF-Export Button erscheint', async ({ page }) => {
    await page.fill('#chatInput', 'Was ist eine Kündigung?');
    await page.click('#sendBtn');
    await expect(page.locator('.feedback-row button:has-text("PDF")').first())
      .toBeVisible({ timeout: 30000 });
  });

});