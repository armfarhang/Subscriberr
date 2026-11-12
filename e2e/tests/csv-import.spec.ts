import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

// Spec §17: import a CSV with one conflict and correct it side by side before commit.

const CSV = ['display_name,etransfer_name,email,notes', 'Pat renamed by the sheet,Pat,payer2@example.com,Imported note', 'Casey Import,CASEY IMPORT,not-an-email,'].join('\r\n');

test('CSV import: keep the current value for a conflict, fix an invalid cell, import', async ({ page }) => {
  await signIn(page);
  await page.goto('/import-export');
  await page.getByLabel('CSV file').setInputFiles({ name: 'members.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf8') });

  // Column matching is detected from the headers.
  await page.getByRole('button', { name: 'Continue to review' }).click();

  const row = (n: number) => page.locator('div.rounded-lg').filter({ has: page.getByText(`Row ${n}`, { exact: true }) }).last();

  // Row 2 matches "Pat (cousin)" by email; the sheet renames them. Keep the app's name.
  const pat = row(2);
  await expect(pat.getByLabel(`Action for row 2`)).toHaveValue('update');
  await pat.getByRole('group', { name: 'Value to keep for Display name' }).getByRole('button', { name: 'Keep' }).click();
  await expect(pat.getByRole('group', { name: 'Value to keep for Display name' }).getByRole('button', { name: 'Keep' })).toHaveAttribute('aria-pressed', 'true');

  // Row 3 is new and has an invalid email: correct it in place.
  const casey = row(3);
  await expect(casey.getByText(/email/i).first()).toBeVisible();
  const email = casey.getByLabel('Email', { exact: true });
  await email.fill('casey@example.com');
  await email.press('Enter');
  await expect(casey.getByText('edited', { exact: true })).toBeVisible();
  await expect(page.getByText('Creates 1 and updates 1 member(s).', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Import 2 member(s)' }).click();
  await page.getByRole('button', { name: 'Yes, import now' }).click();
  await expect(page.getByRole('button', { name: 'Undo this import' })).toBeVisible({ timeout: 30_000 });

  // Pat kept their name but got the new note; Casey exists with the corrected email.
  await page.goto('/members?status=all&q=payer2');
  await expect(page.getByRole('link', { name: 'Pat (cousin)' })).toBeVisible();
  await expect(page.getByText('Pat renamed by the sheet')).toHaveCount(0);
  await page.getByRole('link', { name: 'Pat (cousin)' }).click();
  await expect(page.getByLabel('Notes')).toHaveValue('Imported note');

  await page.goto('/members?status=all&q=casey');
  await page.getByRole('link', { name: 'Casey Import' }).click();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('casey@example.com');
});
