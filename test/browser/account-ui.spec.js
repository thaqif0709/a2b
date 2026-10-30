// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/');
  await page.evaluate(async () => {
    document.getElementById('splash')?.remove();
    const { state } = await import('/core.js');
    state.user = { id: 'synthetic', name: 'Test driver', email: 'driver@example.invalid' };
    const { openSettings } = await import('/panels.js');
    openSettings();
  });
});

test('route loading renders a place name as text without injecting HTML', async ({ page }) => {
  const name = '<b data-injected="yes" onclick="void(0)">Synthetic origin</b>';
  await page.evaluate(async (name) => {
    const { showRouteLoading } = await import('/route-preview.js');
    showRouteLoading(document.getElementById('route-status'), `Finding routes from ${name}…`);
  }, name);
  await expect(page.locator('#route-status')).toHaveText(`Finding routes from ${name}…`);
  await expect(page.locator('#route-status [data-injected]')).toHaveCount(0);
  await expect(page.locator('#route-status .spinner')).toHaveAttribute('aria-hidden', 'true');
});

test('masked form validates, prevents duplicate writes and recovers after a server error', async ({ page }) => {
  let requests = 0, release;
  await page.route('**/api/me', async (route) => {
    requests++;
    await new Promise((resolve) => { release = resolve; });
    await route.fulfill({ status: requests === 1 ? 400 : 200, json: requests === 1 ? { error: 'Current password is incorrect.' } : { ok: true } });
  });
  await page.locator('#s-pass').click();
  const current = page.getByLabel('Current password', { exact: true });
  const next = page.getByLabel('New password', { exact: true });
  const confirm = page.getByLabel('Confirm new password', { exact: true });
  await expect(current).toBeFocused();
  for (const field of [current, next, confirm]) await expect(field).toHaveAttribute('type', 'password');
  await expect(current).toHaveAttribute('autocomplete', 'current-password');
  await expect(next).toHaveAttribute('autocomplete', 'new-password');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(current).toHaveAttribute('aria-invalid', 'true');
  await current.fill('synthetic-current');
  await next.fill('short');
  await page.locator('#password-save').click();
  await expect(next).toHaveAttribute('aria-invalid', 'true');
  await next.fill('synthetic-next');
  await confirm.fill('different');
  await page.locator('#password-save').click();
  await expect(confirm).toBeFocused();
  await expect(page.getByRole('alert')).toContainText('do not match');
  await expect(current).not.toHaveAttribute('aria-describedby');
  await expect(next).toHaveAttribute('aria-describedby', 'password-hint');
  await confirm.fill('synthetic-next');
  await page.locator('#password-save').click();
  await expect.poll(() => requests).toBe(1);
  await expect(page.locator('#password-form')).toHaveAttribute('aria-busy', 'true');
  await page.locator('#password-form').dispatchEvent('submit');
  expect(requests).toBe(1);
  release();
  await expect(page.getByRole('alert')).toContainText('incorrect');
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.locator('#password-save')).toBeEnabled();
  await current.fill('synthetic-correct');
  await page.locator('#password-save').click();
  await expect.poll(() => requests).toBe(2);
  release();
  await expect(page.locator('#panel-title')).toHaveText('Settings');
  await expect(page.locator('#s-pass')).toBeFocused();
  await expect(page.locator('#toast')).toHaveText('Password changed');
  await expect(page.locator('input[type="password"]:visible')).toHaveCount(0);
});

test('late successful password response does not reopen a closed panel', async ({ page }) => {
  let release;
  await page.route('**/api/me', async (route) => {
    await new Promise((resolve) => { release = resolve; });
    await route.fulfill({ json: { ok: true } });
  });
  await page.locator('#s-pass').click();
  await page.locator('#password-current').fill('synthetic-current');
  await page.locator('#password-new').fill('synthetic-next');
  await page.locator('#password-confirm').fill('synthetic-next');
  await page.locator('#password-save').click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate(async () => (await import('/panels.js')).closePanel());
  release();
  await expect(page.locator('#toast')).toHaveText('Password changed');
  await expect(page.locator('#panel')).toBeHidden();
  await expect(page.locator('#password-current')).toHaveValue('');
});

test('leaving a password form clears secrets before submit and after a late failure', async ({ page }) => {
  await page.locator('#s-pass').click();
  await page.locator('#password-current').fill('synthetic-current');
  await page.evaluate(async () => (await import('/panels.js')).closePanel());
  await expect(page.locator('#password-current')).toHaveValue('');
  await page.evaluate(async () => (await import('/panels.js')).openSettings());
  await page.locator('#s-pass').click();
  let release;
  await page.route('**/api/me', async (route) => {
    await new Promise((resolve) => { release = resolve; });
    await route.fulfill({ status: 500, json: { error: 'Try again later.' } });
  });
  await page.locator('#password-current').fill('synthetic-current');
  await page.locator('#password-new').fill('synthetic-next');
  await page.locator('#password-confirm').fill('synthetic-next');
  await page.locator('#password-save').click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.evaluate(async () => (await import('/panels.js')).closePanel());
  release();
  await expect(page.locator('#password-save')).toBeEnabled();
  await expect(page.locator('#panel')).toBeHidden();
  for (const id of ['current', 'new', 'confirm']) await expect(page.locator(`#password-${id}`)).toHaveValue('');
});

test('cancel restores keyboard focus; form fits supported viewports and themes', async ({ page }) => {
  for (const width of [320, 360, 375, 390, 430, 768, 1280]) {
    for (const theme of ['day', 'night']) {
      await page.setViewportSize({ width, height: width === 768 ? 390 : 844 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      await page.locator('#s-pass').click();
      await expect(page.locator('#password-current')).toBeFocused();
      await page.locator('#password-form').evaluate((form) => {
        // Text-only enlargement, not a claim of OS Dynamic Type or a physical keyboard test.
        for (const el of form.querySelectorAll('label,input,button,p')) el.style.fontSize = `${parseFloat(getComputedStyle(el).fontSize) * 2}px`;
      });
      const overflow = await page.locator('#password-form').evaluate((form) => form.scrollWidth > form.clientWidth);
      expect(overflow).toBe(false);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.locator('#s-pass')).toBeFocused();
    }
  }
});
