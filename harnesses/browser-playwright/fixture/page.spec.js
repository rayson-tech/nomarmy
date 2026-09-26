import { test, expect } from '@playwright/test';
test('opens local fixture', async ({ page }) => {
  await page.goto(new URL('./page.html', import.meta.url).href);
  await expect(page.getByRole('heading')).toHaveText('Browser ready');
});
