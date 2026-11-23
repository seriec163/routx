import { expect, test } from '@playwright/test';

test('страница входа открывается и показывает форму', async ({ page }) => {
  const response = await page.goto('/login');

  expect(response?.status() ?? 0).toBeLessThan(500);
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toBeVisible();
});

test('корень без сессии показывает вход', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 });
});
