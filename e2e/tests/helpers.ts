import { expect, type Page } from '@playwright/test';

/** Demo sign-in (DEV_FAKE_LOGIN) as the seeded demo owner; lands on the dashboard. */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Demo sign-in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
}
