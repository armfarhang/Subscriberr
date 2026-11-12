import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

// Spec §17: create member → record payment → status / access change.
// All demo-server accounts are linked to seeded members, so the new member takes over the Plex
// account "pat" from the seeded "Pat (cousin)" first.

test('a new member who pays becomes active and gets their Plex access back', async ({ page }) => {
  await signIn(page);

  // Free the Plex account "pat".
  await page.goto('/members?status=all&q=Pat');
  await page.getByRole('link', { name: 'Pat (cousin)' }).click();
  const serversCard = page.locator('div.rounded-lg', { has: page.getByText('Media servers', { exact: true }) });
  await serversCard.getByRole('button', { name: 'Unlink' }).click();
  await expect(serversCard.getByText('Not linked to any server.')).toBeVisible();

  // Create the member.
  await page.goto('/members/new');
  await page.getByLabel('Display name').fill('E2E Tester');
  await page.getByLabel('Name on their e-Transfers').fill('E2E TESTER');
  await page.getByRole('button', { name: 'Add member' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Tester' })).toBeVisible();
  const memberUrl = page.url();
  await expect(page.getByText('Expired', { exact: true }).first()).toBeVisible();

  // Link them to the Plex account.
  await page.getByLabel('Server', { exact: true }).selectOption({ label: 'Demo Plex' });
  await page.getByLabel('Account on the server').selectOption({ label: 'pat (payer2@example.com)' });
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByText('Plex user pat')).toBeVisible();

  // Turn on enforcement for Demo Plex and approve the first (dry-run) plan.
  await page.goto('/media');
  await page.getByRole('button', { name: /Demo Plex/ }).click();
  const enforce = page.getByLabel('Enforce access on Demo Plex');
  await enforce.click(); // controlled by the server's answer
  await expect(enforce).toBeChecked();
  await page.getByRole('button', { name: 'Preview changes (dry run)' }).click();
  await expect(page.getByText(/Dry run: \d+ change\(s\) would be made\./)).toBeVisible();
  await page.getByRole('button', { name: /Apply \d+ change\(s\)/ }).click();
  await expect(page.getByText(/Applied: \d+ changed, 0 failed\./)).toBeVisible();

  // Expired → access revoked.
  await page.goto(memberUrl);
  await expect(page.getByText('access revoked', { exact: false }).first()).toBeVisible();

  // Record a payment by hand → active, access granted.
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByLabel('Amount', { exact: true }).fill('15.00');
  await page.getByRole('button', { name: 'Record and apply' }).click();
  await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('access granted', { exact: false }).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.getByText(/Payment recorded by hand: \$15\.00/)).toBeVisible();
});
