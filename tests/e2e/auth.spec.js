const { test, expect } = require('@playwright/test');

const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

test.describe('Login & Registrierung', () => {

  test('Login-Screen wird angezeigt', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#authScreen')).toBeVisible();
    await expect(page.locator('#emailInput')).toBeVisible();
    await expect(page.locator('#passwordInput')).toBeVisible();
    await expect(page.locator('#authBtn')).toBeVisible();
  });

  test('Falsche Anmeldedaten → App bleibt verborgen', async ({ page }) => {
    await page.goto('/');
    await page.fill('#emailInput', 'nichtvorhanden@test.at');
    await page.fill('#passwordInput', 'falschespasswort123');
    await page.click('#authBtn');
    await page.waitForTimeout(6000);
    const appVisible = await page.locator('#appScreen').isVisible();
    expect(appVisible).toBe(false);
  });

  test('Tab-Wechsel zwischen Login und Registrieren', async ({ page }) => {
    await page.goto('/');
    await page.click('button:has-text("Registrieren")');
    await expect(page.locator('#authBtn')).toContainText('Registrieren');
    await page.click('button:has-text("Anmelden")');
    await expect(page.locator('#authBtn')).toContainText('Anmelden');
  });

  test('Erfolgreicher Login zeigt App-Screen', async ({ page }) => {
    test.skip(!TEST_EMAIL || !TEST_PASSWORD, 'TEST_EMAIL und TEST_PASSWORD müssen gesetzt sein');
    await page.goto('/');
    await page.fill('#emailInput', TEST_EMAIL);
    await page.fill('#passwordInput', TEST_PASSWORD);
    await page.click('#authBtn');
    // Warte auf #chatEmpty oder #chatMessages — diese erscheinen nur nach erfolgreichem Login
    await expect(page.locator('#chatEmpty')).toBeVisible({ timeout: 30000 });
  });

});