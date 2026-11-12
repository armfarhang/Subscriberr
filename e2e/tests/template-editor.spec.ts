import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

// Spec §17: edit a template and preview it.

test('duplicate the default pack, edit the thank-you email, see it in the preview, save it', async ({ page }) => {
  await signIn(page);
  await page.goto('/templates');

  await page.getByLabel('Name for the copy').fill('E2E pack');
  await page.getByRole('button', { name: /Duplicate/ }).click();
  await expect(page.getByRole('button', { name: 'Save theme' })).toBeVisible();
  await expect(page.getByText('Built-in packs are read-only', { exact: false })).toHaveCount(0);

  await page.getByRole('button', { name: 'thanks.html', exact: true }).click();
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('<p>E2E-MARKER for {{member.display_name}}</p>\n');

  // The live preview follows the unsaved edit.
  const preview = page.frameLocator('iframe[title="Email preview"]');
  await expect(preview.getByText(/E2E-MARKER for /)).toBeVisible();

  await page.getByRole('button', { name: 'Save thanks.html' }).click();
  await expect(page.getByRole('button', { name: 'Save thanks.html' })).toBeDisabled();

  // After a reload the saved file still renders in the preview.
  await page.reload();
  await page.getByRole('button', { name: /E2E pack/ }).first().click();
  await expect(page.frameLocator('iframe[title="Email preview"]').getByText(/E2E-MARKER for /)).toBeVisible();
});
