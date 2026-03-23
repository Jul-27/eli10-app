const { test, expect } = require('@playwright/test');

const TEST_EMAIL = process.env.TEST_EMAIL || 'test@dokuvo.at';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'TestPassword123!';

test.describe('Login & Registrierung', () => {

  test('Login-Screen wird angezeigt', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.auth-title, h1')).toContainText('Dokuvo');
    await expect(page.locator('#emailInput')).toBeVisible();
    await expect(page.locator('#passwordInput')).toBeVisible();
    await expect(page.locator('#authBtn')).toBeVisible();
  });

  test('Falsche Anmeldedaten zeigen Fehlermeldung', async ({ page }) => {
    await page.goto('/');
    await page.fill('#emailInput', 'falsch@test.at');
    await page.fill('#passwordInput', 'falschespasswort');
    await page.click('#authBtn');
    await expect(page.locator('#authMessage')).toBeVisible({ timeout: 8000 });
    const msg = await page.locator('#authMessage').textContent();
    expect(msg?.length).toBeGreaterThan(0);
  });

  test('Erfolgreicher Login zeigt App-Screen', async ({ page }) => {
    await page.goto('/');
    await page.fill('#emailInput', TEST_EMAIL);
    await page.fill('#passwordInput', TEST_PASSWORD);
    await page.click('#authBtn');
    await expect(page.locator('#appScreen')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.sidebar-logo, .header-logo')).toBeVisible();
  });

  test('Tab-Wechsel zwischen Login und Registrieren', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("Registrieren")');
    await expect(page.locator('#authBtn')).toContainText('Registrieren');
    await page.click('button:has-text("Anmelden")');
    await expect(page.locator('#authBtn')).toContainText('Anmelden');
  });

});